const path = require('path')
const parseDatURL = require('parse-dat-url')
const pda = require('pauls-dat-api')
const EventTarget = require('dom-event-target')
const concat = require('concat-stream')
const pick = require('lodash.pick')
const {timer, Event, toEventTarget} = require('./util')
const {
  DAT_MANIFEST_FILENAME,
  DAT_CONFIGURABLE_FIELDS,
  DAT_VALID_PATH_REGEX,
  DEFAULT_DAT_API_TIMEOUT
} = require('./const')
const {
  ArchiveNotWritableError,
  ProtectedFileNotWritableError,
  InvalidPathError
} = require('beaker-error-constants')

// exported api
// =

class DatArchive extends EventTarget {
  constructor (datInfo, datnode) {
    super()
    const urlp = parseDatURL(`dat://${datInfo.key}`)
    this.url = urlp ? `dat://${urlp.hostname}` : null

    this._datnode = datnode
    this._dataStructure = datInfo.dataStructure
    this._version = urlp && urlp.version ? +urlp.version : null
    this._checkout = (this._version) ? datInfo.dataStructure.checkout(this._version) : datInfo.dataStructure

    // bubble network events
    var s = toEventTarget(pda.createNetworkActivityStream(this._dataStructure))
    s.addEventListener('network-changed', detail => this.send(new Event('network-changed', {target: this, connections: detail.connections})))
    s.addEventListener('download', detail => this.send(new Event('download', {target: this, feed: detail.feed, block: detail.block, bytes: detail.bytes})))
    s.addEventListener('upload', detail => this.send(new Event('upload', {target: this, feed: detail.feed, block: detail.block, bytes: detail.bytes})))
    s.addEventListener('sync', detail => this.send(new Event('sync', {target: this, feed: detail.feed})))
  }

  async configure (settings) {
    if (!settings || typeof settings !== 'object') throw new Error('Invalid argument')

    // manifest updates
    let manifestUpdates = pick(settings, DAT_CONFIGURABLE_FIELDS)
    if (Object.keys(manifestUpdates).length === 0) {
      // no manifest updates
      return
    }
    await pda.updateManifest(this._dataStructure, settings)
  }

  async getInfo (url, opts = {}) {
    return timer(to(opts), async () => {
      // read manifest
      var manifest
      try {
        manifest = await pda.readManifest(this._checkout)
      } catch (e) {
        manifest = {}
      }

      // read archive info
      const calculateUsage = (type) => type ? (type.downloaded() / type.length) * type.byteLength : 0;
      const size = calculateUsage(this._dataStructure.metadata) + calculateUsage(this._dataStructure.content);

      // return
      return {
        key: this._dataStructure.key.toString('hex'),
        url: this.url,
        isOwner: this._dataStructure.writable,

        // state
        version: this._checkout.version,
        peers: this._dataStructure.metadata.peers.length,
        mtime: 0,
        size,

        // manifest
        title: manifest.title,
        description: manifest.description,
        type: manifest.type,
        author: manifest.author
      }
    })
  }

  async history (opts = {}) {
    return timer(to(opts), async () => {
      var reverse = opts.reverse === true
      var {start, end} = opts

      // if reversing the output, modify start/end
      start = start || 0
      end = end || this._checkout.metadata.length
      if (reverse) {
        // swap values
        let t = start
        start = end
        end = t
        // start from the end
        start = this._checkout.metadata.length - start
        end = this._checkout.metadata.length - end
      }

      return new Promise((resolve, reject) => {
        var stream = this._checkout.history({live: false, start, end})
        stream.pipe(concat({encoding: 'object'}, values => {
          values = values.map(massageHistoryObj)
          if (reverse) values.reverse()
          resolve(values)
        }))
        stream.on('error', reject)
      })
    })
  }

  async stat (filepath, opts = {}) {
    filepath = massageFilepath(filepath)
    return timer(to(opts), async () => {
      return pda.stat(this._checkout, filepath)
    })
  }

  async readFile (filepath, opts = {}) {
    filepath = massageFilepath(filepath)
    return timer(to(opts), async () => {
      return pda.readFile(this._checkout, filepath, opts)
    })
  }

  async writeFile (filepath, data, opts = {}) {
    filepath = massageFilepath(filepath)
    return timer(to(opts), async () => {
      if (this._version) throw new ArchiveNotWritableError('Cannot modify a historic version')
      await assertWritePermission(this._dataStructure)
      await assertValidFilePath(filepath)
      await assertUnprotectedFilePath(filepath)
      return pda.writeFile(this._dataStructure, filepath, data, opts)
    })
  }

  async unlink (filepath) {
    filepath = massageFilepath(filepath)
    return timer(to(), async () => {
      if (this._version) throw new ArchiveNotWritableError('Cannot modify a historic version')
      await assertWritePermission(this._dataStructure)
      await assertUnprotectedFilePath(filepath)
      return pda.unlink(this._dataStructure, filepath)
    })
  }

  async download (filepath, opts = {}) {
    filepath = massageFilepath(filepath)
    return timer(to(opts), async (checkin) => {
      if (this._version) throw new Error('Not yet supported: can\'t download() old versions yet. Sorry!') // TODO
      if (this._dataStructure.writable) {
        return // no need to download
      }
      return pda.download(this._dataStructure, filepath)
    })
  }

  async readdir (filepath, opts = {}) {
    filepath = massageFilepath(filepath)
    return timer(to(opts), async () => {
      var names = await pda.readdir(this._checkout, filepath, opts)
      if (opts.stat) {
        for (let i = 0; i < names.length; i++) {
          names[i] = {
            name: names[i],
            stat: await pda.stat(this._checkout, path.join(filepath, names[i]))
          }
        }
      }
      return names
    })
  }

  async mkdir (filepath) {
    filepath = massageFilepath(filepath)
    return timer(to(), async () => {
      if (this._version) throw new ArchiveNotWritableError('Cannot modify a historic version')
      await assertWritePermission(this._dataStructure)
      await assertValidPath(filepath)
      await assertUnprotectedFilePath(filepath)
      return pda.mkdir(this._dataStructure, filepath)
    })
  }

  async rmdir (filepath, opts = {}) {
    return timer(to(opts), async () => {
      filepath = massageFilepath(filepath)
      if (this._version) throw new ArchiveNotWritableError('Cannot modify a historic version')
      await assertUnprotectedFilePath(filepath)
      return pda.rmdir(this._dataStructure, filepath, opts)
    })
  }

  async copy (path, dstPath, opts) {
    path = massageFilepath(path)
    dstPath = massageFilepath(dstPath);
    return timer(to(opts), async () => {
      if (this._version) throw new ArchiveNotWritableError('Cannot modify a historic version')
      await pda.copy(this._dataStructure, path, dstPath)
    })
  }

  async rename(filepath, dstpath, opts) {
    filepath = massageFilepath(filepath)
    dstpath = massageFilepath(dstpath);
    return timer(to(opts), async () => {
      if (this._version) throw new ArchiveNotWritableError('Cannot modify a historic version')
      await pda.rename(this._dataStructure, filepath, dstpath)
    })
  }

  watch (pathPattern, onInvalidated) {
    // watch(fn) usage
    if (typeof pathPattern === 'function') {
      onInvalidated = pathPattern
      pathPattern = null
    }

    var evts = toEventTarget(pda.watch(this._dataStructure, pathPattern))
    if (onInvalidated) evts.addEventListener('invalidated', onInvalidated)
    return evts
  }

  static async resolveName (name) {
    return this._datnode.dns.resolve(name)
  }
}
module.exports = DatArchive

// internal helpers
// =

const to = (opts) =>
  (opts && typeof opts.timeout !== 'undefined')
    ? opts.timeout
    : DEFAULT_DAT_API_TIMEOUT

// helper to check if filepath refers to a file that userland is not allowed to edit directly
function assertUnprotectedFilePath (filepath) {
  // TODO disabled -- does dat-node need this protection?
  // if (filepath === '/' + DAT_MANIFEST_FILENAME) {
  //   throw new ProtectedFileNotWritableError()
  // }
}

async function assertWritePermission (archive) {
  // ensure we have the archive's private key
  if (!archive.writable) {
    throw new ArchiveNotWritableError()
  }
  return true
}

async function assertValidFilePath (filepath) {
  if (filepath.slice(-1) === '/') {
    throw new InvalidPathError('Files can not have a trailing slash')
  }
  await assertValidPath(filepath)
}

async function assertValidPath (fileOrFolderPath) {
  if (!DAT_VALID_PATH_REGEX.test(fileOrFolderPath)) {
    throw new InvalidPathError('Path contains invalid characters')
  }
}

function massageHistoryObj ({name, version, type}) {
  return {path: name, version, type}
}

function massageFilepath (filepath) {
  filepath = filepath || ''
  filepath = decodeURIComponent(filepath)
  if (!filepath.startsWith('/')) {
    filepath = '/' + filepath
  }
  return filepath
}
