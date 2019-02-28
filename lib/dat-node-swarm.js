const EventEmitter = require('events')
const crypto = require('crypto')
const datEncoding = require('dat-encoding')
const swarmDefaults = require('dat-swarm-defaults')
const discoverySwarm = require('discovery-swarm')
const hypercoreProtocol = require('hypercore-protocol')
const DSS = require('discovery-swarm-stream/client')
const Websocket = require('websocket-stream')

const {toKey, log} = require('./util')

const EventObjects = {
  Peer: require('./event-objects/peer'),
  Connection: require('./event-objects/connection')
}

const DAT_SWARM_PORT = 0 // 3282 is the real default, but `0` just gets us a free random port

// exported api
// =

class DatNodeSwarm extends EventEmitter {
  constructor (datnode, opts) {
    super()
    this.networkId = crypto.randomBytes(32)
    this.port = typeof opts.port === 'number' ? opts.port : DAT_SWARM_PORT

    this._datnode = datnode
    this._initSwarm = async () => {
      if (opts.dss) {
        const socket = Websocket(opts.dss);
  
        this._swarm = new DSS({
          id: this.networkId,
          hash: false,
          utp: false,
          tcp: true,
          dht: false,
          connection: socket,
          stream: (info) => createReplicationStream(datnode, info)
        })
  
        // socket reconnection
        socket.on('error', err => datnode.emit('error', err))
        // this.emit('listening', 0)
      } else {
        this._swarm = discoverySwarm(swarmDefaults({
          id: this.networkId,
          hash: false,
          utp: false,
          tcp: true,
          dht: true,
          stream: (info) => createReplicationStream(datnode, info)
        }))
      }

      // bubble listening and error to the datnode
      this._swarm.on('listening', () => {
        this.port = this._swarm.address().port
        datnode.emit('listening', this.port)
        this.emit('listening', this.port)
        log(datnode, 'swarm:listening', {port: this.port})
      })
      this._swarm.on('error', err => datnode.emit('error', err))

      // re-emit a variety of events
      const reEmit = (event, mod) => {
        this._swarm.on(event, (...args) => {
          if (mod) args = mod(args)
          this.emit(event, ...args)
          log(datnode, `swarm:${event}`, ...args)
        })
      }
      reEmit('error')
      reEmit('peer', ([peer]) => ([new EventObjects.Peer(peer)]))
      reEmit('peer-banned', ([peer, reason]) => ([new EventObjects.Peer(peer), reason]))
      reEmit('peer-rejected', ([peer, reason]) => ([new EventObjects.Peer(peer), reason]))
      reEmit('drop', ([peer]) => ([new EventObjects.Peer(peer)]))
      reEmit('connecting', ([peer]) => ([new EventObjects.Peer(peer)]))
      reEmit('connect-failed', ([peer, reason]) => ([new EventObjects.Peer(peer), reason]))
      reEmit('handshaking', ([connection, info]) => ([new EventObjects.Connection(connection)]))
      reEmit('handshake-timeout', ([connection, info]) => ([new EventObjects.Connection(connection)]))
      reEmit('connection', ([connection, info]) => ([new EventObjects.Connection(connection)]))
      reEmit('connection-closed', ([connection, info]) => ([new EventObjects.Connection(connection)]))
      reEmit('redundant-connection', ([connection, info]) => ([new EventObjects.Connection(connection)]))

      if (opts.autoListen !== false) {
        this._listen()
      }
    }
  }

  async join (url) {
    var key = toKey(url)
    var dat = this._datnode._dats[key]
    if (!dat || dat.isSwarming) return
    if (!this._swarm) this._initSwarm();

    var discoveryKey = datEncoding.toStr(dat.discoveryKey)
    this.emit('join', {key, discoveryKey})
    log(this._datnode, key, {event: 'swarm:join', key, discoveryKey})

    this._swarm.join(datEncoding.toBuf(dat.discoveryKey))
    dat.isSwarming = true
  }

  async leave (url) {
    var key = toKey(url)
    var dat = this._datnode._dats[key]
    if (!dat || !dat.isSwarming) return
    if (!this._swarm) this._initSwarm();

    var discoveryKey = datEncoding.toStr(dat.discoveryKey)
    this.emit('join', {key, discoveryKey})
    log(this._datnode, key, {event: 'swarm:leave', key, discoveryKey})

    dat.replicationStreams.forEach(stream => stream.destroy()) // stop all active replications
    dat.replicationStreams.length = 0
    this._swarm.leave(datEncoding.toBuf(dat.discoveryKey))
    dat.isSwarming = false
  }

  _listen (port) {
    port = port || this.port
    if (!this._swarm) this._initSwarm();
    this._swarm.listen(port)
    return new Promise(resolve => {
      this._swarm.once('listening', resolve)
    })
  }

  _close () {
    return new Promise(resolve => {
      this._swarm.close(resolve)
    })
  }
}

module.exports = DatNodeSwarm

// internal
// =

function createReplicationStream (datnode, info) {
  // create the protocol stream
  var streamKeys = [] // list of keys replicated over the streamd
  var stream = hypercoreProtocol({
    id: datnode.swarm.networkId,
    live: true,
    encrypt: true
  })
  stream.peerInfo = info

  // add the dat if the discovery network gave us any info
  if (info.channel) {
    add(info.channel)
  }

  // add any requested dats
  stream.on('feed', add)

  function add (dkey) {
    // lookup the dat
    var dkeyStr = datEncoding.toStr(dkey)
    var dat = datnode._datsByDKey[dkeyStr]
    if (!dat || !dat.isSwarming) {
      return
    }
    if (dat.replicationStreams.indexOf(stream) !== -1) {
      return // already replicating
    }

    // create the replication stream
    dat.dataStructure.replicate({stream, live: true})
    if (stream.destroyed) return // in case the stream was destroyed during setup

    // track the stream
    var keyStr = datEncoding.toStr(dat.key)
    streamKeys.push(keyStr)
    dat.replicationStreams.push(stream)
    function onend () {
      dat.replicationStreams = dat.replicationStreams.filter(s => (s !== stream))
    }
    stream.once('error', onend)
    stream.once('end', onend)
    stream.once('close', onend)
  }

  // debugging
  stream.on('error', err => {
    log(datnode, streamKeys, {
      event: 'connection-error',
      peer: `${info.host}:${info.port}`,
      connectionType: info.type,
      message: err.toString()
    })
  })
  return stream
}
