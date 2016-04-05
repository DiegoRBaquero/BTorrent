(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.WebTorrent = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
(function (Buffer){
module.exports = function (stream, cb) {
  var chunks = []
  stream.on('data', function (chunk) {
    chunks.push(chunk)
  })
  stream.once('end', function () {
    if (cb) cb(null, Buffer.concat(chunks))
    cb = null
  })
  stream.once('error', function (err) {
    if (cb) cb(err)
    cb = null
  })
}

}).call(this,require("buffer").Buffer)
},{"buffer":25}],2:[function(require,module,exports){
module.exports = FileStream

var debug = require('debug')('webtorrent:file-stream')
var inherits = require('inherits')
var stream = require('readable-stream')

inherits(FileStream, stream.Readable)

/**
 * Readable stream of a torrent file
 *
 * @param {File} file
 * @param {Object} opts
 * @param {number} opts.start stream slice of file, starting from this byte (inclusive)
 * @param {number} opts.end stream slice of file, ending with this byte (inclusive)
 */
function FileStream (file, opts) {
  stream.Readable.call(this, opts)

  this.destroyed = false
  this._torrent = file._torrent

  var start = (opts && opts.start) || 0
  var end = (opts && opts.end && opts.end < file.length)
    ? opts.end
    : file.length - 1

  var pieceLength = file._torrent.pieceLength

  this._startPiece = (start + file.offset) / pieceLength | 0
  this._endPiece = (end + file.offset) / pieceLength | 0

  this._piece = this._startPiece
  this._offset = (start + file.offset) - (this._startPiece * pieceLength)

  this._missing = end - start + 1
  this._reading = false
  this._notifying = false
  this._criticalLength = Math.min((1024 * 1024 / pieceLength) | 0, 2)
}

FileStream.prototype._read = function () {
  if (this._reading) return
  this._reading = true
  this._notify()
}

FileStream.prototype._notify = function () {
  var self = this

  if (!self._reading || self._missing === 0) return
  if (!self._torrent.bitfield.get(self._piece)) {
    return self._torrent.critical(self._piece, self._piece + self._criticalLength)
  }

  if (self._notifying) return
  self._notifying = true

  var p = self._piece
  self._torrent.store.get(p, function (err, buffer) {
    self._notifying = false
    if (self.destroyed) return
    if (err) return self._destroy(err)
    debug('read %s (length %s) (err %s)', p, buffer.length, err && err.message)

    if (self._offset) {
      buffer = buffer.slice(self._offset)
      self._offset = 0
    }

    if (self._missing < buffer.length) {
      buffer = buffer.slice(0, self._missing)
    }
    self._missing -= buffer.length

    debug('pushing buffer of length %s', buffer.length)
    self._reading = false
    self.push(buffer)

    if (self._missing === 0) self.push(null)
  })
  self._piece += 1
}

FileStream.prototype.destroy = function (onclose) {
  this._destroy(null, onclose)
}

FileStream.prototype._destroy = function (err, onclose) {
  if (this.destroyed) return
  if (onclose) this.once('close', onclose)
  this.destroyed = true

  if (!this._torrent.destroyed) {
    this._torrent.deselect(this._startPiece, this._endPiece, true)
  }

  if (err) this.emit('error', err)
  this.emit('close')
}

},{"debug":93,"inherits":101,"readable-stream":133}],3:[function(require,module,exports){
(function (process){
module.exports = File

var eos = require('end-of-stream')
var EventEmitter = require('events').EventEmitter
var FileStream = require('./file-stream')
var inherits = require('inherits')
var path = require('path')
var render = require('render-media')
var stream = require('readable-stream')
var streamToBlobURL = require('stream-to-blob-url')
var streamToBuffer = require('stream-with-known-length-to-buffer')

inherits(File, EventEmitter)

/**
 * @param {Torrent} torrent torrent that the file belongs to
 * @param {Object} file file object from the parsed torrent
 */
function File (torrent, file) {
  EventEmitter.call(this)

  this._torrent = torrent

  this.name = file.name
  this.path = file.path
  this.length = file.length
  this.offset = file.offset

  this.done = false

  var start = file.offset
  var end = start + file.length - 1

  this._startPiece = start / this._torrent.pieceLength | 0
  this._endPiece = end / this._torrent.pieceLength | 0

  if (this.length === 0) {
    this.done = true
    this.emit('done')
  }
}

/**
 * Selects the file to be downloaded, but at a lower priority than files with streams.
 * Useful if you know you need the file at a later stage.
 */
File.prototype.select = function (priority) {
  if (this.length === 0) return
  this._torrent.select(this._startPiece, this._endPiece, priority)
}

/**
 * Deselects the file, which means it won't be downloaded unless someone creates a stream
 * for it.
 */
File.prototype.deselect = function () {
  if (this.length === 0) return
  this._torrent.deselect(this._startPiece, this._endPiece, false)
}

/**
 * Create a readable stream to the file. Pieces needed by the stream will be prioritized
 * highly and fetched from the swarm first.
 *
 * @param {Object=} opts
 * @param {number} opts.start start stream at byte (inclusive)
 * @param {number} opts.end end stream at byte (inclusive)
 * @return {FileStream}
 */
File.prototype.createReadStream = function (opts) {
  var self = this
  if (this.length === 0) {
    var empty = new stream.PassThrough()
    process.nextTick(function () {
      empty.end()
    })
    return empty
  }

  var fileStream = new FileStream(self, opts)
  self._torrent.select(fileStream._startPiece, fileStream._endPiece, true, function () {
    fileStream._notify()
  })
  eos(fileStream, function () {
    if (!self._torrent.destroyed) {
      self._torrent.deselect(fileStream._startPiece, fileStream._endPiece, true)
    }
  })
  return fileStream
}

/**
 * @param {function} cb
 */
File.prototype.getBuffer = function (cb) {
  streamToBuffer(this.createReadStream(), this.length, cb)
}

/**
 * @param {function} cb
 */
File.prototype.getBlobURL = function (cb) {
  if (typeof window === 'undefined') throw new Error('browser-only method')
  var mime = render.mime[path.extname(this.name).toLowerCase()]
  streamToBlobURL(this.createReadStream(), mime, cb)
}

/**
 * @param {Element|string} elem
 * @param {function} cb
 */
File.prototype.appendTo = function (elem, cb) {
  if (typeof window === 'undefined') throw new Error('browser-only method')
  render.append(this, elem, cb)
}

/**
 * @param {Element|string} elem
 * @param {function} cb
 */
File.prototype.renderTo = function (elem, cb) {
  if (typeof window === 'undefined') throw new Error('browser-only method')
  render.render(this, elem, cb)
}

}).call(this,require('_process'))
},{"./file-stream":2,"_process":33,"end-of-stream":96,"events":29,"inherits":101,"path":32,"readable-stream":133,"render-media":136,"stream-to-blob-url":150,"stream-with-known-length-to-buffer":153}],4:[function(require,module,exports){
var arrayRemove = require('unordered-array-remove')
var debug = require('debug')('webtorrent:peer')
var Wire = require('bittorrent-protocol')

var WebConn = require('./webconn')

var CONNECT_TIMEOUT_TCP = 5000
var CONNECT_TIMEOUT_WEBRTC = 25000
var HANDSHAKE_TIMEOUT = 25000

/**
 * WebRTC peer connections start out connected, because WebRTC peers require an
 * "introduction" (i.e. WebRTC signaling), and there's no equivalent to an IP address
 * that lets you refer to a WebRTC endpoint.
 */
exports.createWebRTCPeer = function (conn, swarm) {
  var peer = new Peer(conn.id, 'webrtc')
  peer.conn = conn
  peer.swarm = swarm

  if (peer.conn.connected) {
    peer.onConnect()
  } else {
    peer.conn.once('connect', function () { peer.onConnect() })
    peer.conn.once('error', function (err) { peer.destroy(err) })
    peer.startConnectTimeout()
  }

  return peer
}

/**
 * Incoming TCP peers start out connected, because the remote peer connected to the
 * listening port of the TCP server. Until the remote peer sends a handshake, we don't
 * know what swarm the connection is intended for.
 */
exports.createTCPIncomingPeer = function (conn) {
  var addr = conn.remoteAddress + ':' + conn.remotePort
  var peer = new Peer(addr, 'tcpIncoming')
  peer.conn = conn
  peer.addr = addr

  peer.onConnect()

  return peer
}

/**
 * Outgoing TCP peers start out with just an IP address. At some point (when there is an
 * available connection), the client can attempt to connect to the address.
 */
exports.createTCPOutgoingPeer = function (addr, swarm) {
  var peer = new Peer(addr, 'tcpOutgoing')
  peer.addr = addr
  peer.swarm = swarm

  return peer
}

/**
 * Peer that represents a Web Seed (BEP17 / BEP19).
 */
exports.createWebSeedPeer = function (url, parsedTorrent, swarm) {
  var peer = new Peer(url, 'webSeed')
  peer.swarm = swarm
  peer.conn = new WebConn(url, parsedTorrent)

  peer.onConnect()

  return peer
}

/**
 * Peer. Represents a peer in the Swarm.
 *
 * @param {string} id "ip:port" string, peer id (for WebRTC peers), or url (for Web Seeds)
 * @param {string} type the type of the peer
 */
function Peer (id, type) {
  var self = this
  self.id = id
  self.type = type

  debug('new Peer %s', id)

  self.addr = null
  self.conn = null
  self.swarm = null
  self.wire = null

  self.connected = false
  self.destroyed = false
  self.timeout = null // handshake timeout
  self.retries = 0 // outgoing TCP connection retry count

  self.sentHandshake = false
}

/**
 * Called once the peer is connected (i.e. fired 'connect' event)
 * @param {Socket} conn
 */
Peer.prototype.onConnect = function () {
  var self = this
  if (self.destroyed) return
  self.connected = true

  debug('Peer %s connected', self.id)

  clearTimeout(self.connectTimeout)

  var conn = self.conn
  conn.once('end', function () {
    self.destroy()
  })
  conn.once('close', function () {
    self.destroy()
  })
  conn.once('finish', function () {
    self.destroy()
  })
  conn.once('error', function (err) {
    self.destroy(err)
  })

  var wire = self.wire = new Wire()
  wire.type = self.type
  wire.once('end', function () {
    self.destroy()
  })
  wire.once('close', function () {
    self.destroy()
  })
  wire.once('finish', function () {
    self.destroy()
  })
  wire.once('error', function (err) {
    self.destroy(err)
  })

  wire.once('handshake', function (infoHash, peerId) {
    self.onHandshake(infoHash, peerId)
  })
  self.startHandshakeTimeout()

  conn.pipe(wire).pipe(conn)
  if (self.swarm && !self.sentHandshake) self.handshake()
}

/**
 * Called when handshake is received from remote peer.
 * @param {string} infoHash
 * @param {string} peerId
 */
Peer.prototype.onHandshake = function (infoHash, peerId) {
  var self = this
  if (!self.swarm) return // `self.swarm` not set yet, so do nothing

  if (self.swarm.destroyed) return self.destroy(new Error('swarm already destroyed'))
  if (infoHash !== self.swarm.infoHash) {
    return self.destroy(new Error('unexpected handshake info hash for this swarm'))
  }
  if (peerId === self.swarm.peerId) {
    return self.destroy(new Error('refusing to handshake with self'))
  }

  debug('Peer %s got handshake %s', self.id, infoHash)

  clearTimeout(self.handshakeTimeout)

  self.retries = 0

  self.wire.on('download', function (downloaded) {
    if (self.destroyed) return
    self.swarm.downloaded += downloaded
    self.swarm.downloadSpeed(downloaded)
    self.swarm.emit('download', downloaded)
  })

  self.wire.on('upload', function (uploaded) {
    if (self.destroyed) return
    self.swarm.uploaded += uploaded
    self.swarm.uploadSpeed(uploaded)
    self.swarm.emit('upload', uploaded)
  })

  self.swarm.wires.push(self.wire)

  var addr = self.addr
  if (!addr && self.conn.remoteAddress) {
    addr = self.conn.remoteAddress + ':' + self.conn.remotePort
  }
  self.swarm.emit('wire', self.wire, addr)
  // swarm could be destroyed in user's 'wire' event handler
  if (!self.swarm || self.swarm.destroyed) return

  if (!self.sentHandshake) self.handshake()
}

Peer.prototype.handshake = function () {
  var self = this
  self.wire.handshake(self.swarm.infoHash, self.swarm.peerId, self.swarm.handshakeOpts)
  self.sentHandshake = true
}

Peer.prototype.startConnectTimeout = function () {
  var self = this
  clearTimeout(self.connectTimeout)
  self.connectTimeout = setTimeout(function () {
    self.destroy(new Error('connect timeout'))
  }, self.type === 'webrtc' ? CONNECT_TIMEOUT_WEBRTC : CONNECT_TIMEOUT_TCP)
  if (self.connectTimeout.unref) self.connectTimeout.unref()
}

Peer.prototype.startHandshakeTimeout = function () {
  var self = this
  clearTimeout(self.handshakeTimeout)
  self.handshakeTimeout = setTimeout(function () {
    self.destroy(new Error('handshake timeout'))
  }, HANDSHAKE_TIMEOUT)
  if (self.handshakeTimeout.unref) self.handshakeTimeout.unref()
}

Peer.prototype.destroy = function (err) {
  var self = this
  if (self.destroyed) return
  self.destroyed = true
  self.connected = false

  debug('destroy %s (error: %s)', self.id, err && (err.message || err))

  clearTimeout(self.connectTimeout)
  clearTimeout(self.handshakeTimeout)

  var swarm = self.swarm
  var conn = self.conn
  var wire = self.wire

  self.conn = null
  self.swarm = null
  self.wire = null

  if (swarm && wire) {
    arrayRemove(swarm.wires, swarm.wires.indexOf(wire))
  }
  if (conn) {
    conn.on('error', noop)
    conn.destroy()
  }
  if (wire) wire.destroy()
  if (swarm) swarm.removePeer(self.id)
}

function noop () {}

},{"./webconn":8,"bittorrent-protocol":11,"debug":93,"unordered-array-remove":159}],5:[function(require,module,exports){
module.exports = RarityMap

/**
 * Mapping of torrent pieces to their respective availability in the swarm. Used by
 * the torrent manager for implementing the rarest piece first selection strategy.
 *
 * @param {Swarm}  swarm bittorrent-swarm to track availability
 * @param {number} numPieces number of pieces in the torrent
 */
function RarityMap (swarm, numPieces) {
  var self = this

  self.pieces = []
  self.swarm = swarm
  self.numPieces = numPieces

  function initWire (wire) {
    wire.on('have', function (index) {
      self.pieces[index] += 1
    })
    wire.on('bitfield', function () {
      self.recalculate()
    })
    wire.on('close', function () {
      for (var i = 0; i < self.numPieces; ++i) {
        self.pieces[i] -= wire.peerPieces.get(i)
      }
    })
  }

  self.swarm.wires.forEach(initWire)
  self.swarm.on('wire', function (wire) {
    self.recalculate()
    initWire(wire)
  })

  self.recalculate()
}

/**
 * Recalculates piece availability across all peers in the swarm.
 */
RarityMap.prototype.recalculate = function () {
  var self = this

  for (var i = 0; i < self.numPieces; ++i) {
    self.pieces[i] = 0
  }

  self.swarm.wires.forEach(function (wire) {
    for (var i = 0; i < self.numPieces; ++i) {
      self.pieces[i] += wire.peerPieces.get(i)
    }
  })
}

/**
 * Get the index of the rarest piece. Optionally, pass a filter function to exclude
 * certain pieces (for instance, those that we already have).
 *
 * @param {function} pieceFilterFunc
 * @return {number} index of rarest piece, or -1
 */
RarityMap.prototype.getRarestPiece = function (pieceFilterFunc) {
  var self = this
  var candidates = []
  var min = Infinity
  pieceFilterFunc = pieceFilterFunc || function () { return true }

  for (var i = 0; i < self.numPieces; ++i) {
    if (!pieceFilterFunc(i)) continue

    var availability = self.pieces[i]
    if (availability === min) {
      candidates.push(i)
    } else if (availability < min) {
      candidates = [ i ]
      min = availability
    }
  }

  if (candidates.length > 0) {
    // if there are multiple pieces with the same availability, choose one randomly
    return candidates[Math.random() * candidates.length | 0]
  } else {
    return -1
  }
}

},{}],6:[function(require,module,exports){
(function (process,Buffer){
module.exports = Swarm

var addrToIPPort = require('addr-to-ip-port')
var debug = require('debug')('webtorrent:swarm')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var net = require('net') // browser exclude
var speedometer = require('speedometer')

var Peer = require('./peer')
var TCPPool = require('./tcp-pool') // browser-exclude

var MAX_CONNS = 55
var RECONNECT_WAIT = [ 1000, 5000, 15000 ]

inherits(Swarm, EventEmitter)

/**
 * BitTorrent Swarm
 *
 * Abstraction of a BitTorrent "swarm", which is handy for managing all peer
 * connections for a given torrent download. This handles connecting to peers,
 * listening for incoming connections, and doing the initial peer wire protocol
 * handshake with peers. It also tracks total data uploaded/downloaded to/from
 * the swarm.
 *
 * @param {Buffer|string} infoHash
 * @param {Buffer|string} peerId
 * @param {Object} opts
 * @param {Object} opts.handshake handshake options (passed to bittorrent-protocol)
 * @param {number} opts.maxConns maximum number of connections in swarm
 */
function Swarm (infoHash, peerId, opts) {
  var self = this
  if (!(self instanceof Swarm)) return new Swarm(infoHash, peerId, opts)
  EventEmitter.call(self)

  self.infoHash = typeof infoHash === 'string'
    ? infoHash
    : infoHash.toString('hex')
  self.infoHashBuffer = new Buffer(self.infoHash, 'hex')

  self.peerId = typeof peerId === 'string'
    ? peerId
    : peerId.toString('hex')
  self.peerIdBuffer = new Buffer(self.peerId, 'hex')

  if (!opts) opts = {}

  debug('new swarm (i %s p %s)', self.infoHash, self.peerId)

  self.handshakeOpts = opts.handshake // handshake extensions (optional)
  self.maxConns = Number(opts.maxConns) || MAX_CONNS

  self.destroyed = false
  self.listening = false
  self.paused = false

  self.server = null // tcp listening socket
  self.wires = [] // open wires (added *after* handshake)

  self._queue = [] // queue of outgoing tcp peers to connect to
  self._peers = {} // connected peers (addr/peerId -> Peer)
  self._peersLength = 0 // number of elements in `self._peers` (cache, for perf)
  self._port = 0 // tcp listening port (cache, for perf)

  // track stats
  self.downloaded = 0
  self.uploaded = 0
  self.downloadSpeed = speedometer()
  self.uploadSpeed = speedometer()
}

Object.defineProperty(Swarm.prototype, 'ratio', {
  get: function () {
    var self = this
    return (self.uploaded / self.downloaded) || 0
  }
})

Object.defineProperty(Swarm.prototype, 'numQueued', {
  get: function () {
    var self = this
    return self._queue.length + (self._peersLength - self.numConns)
  }
})

Object.defineProperty(Swarm.prototype, 'numConns', {
  get: function () {
    var self = this
    var numConns = 0
    for (var id in self._peers) {
      if (self._peers[id].connected) numConns += 1
    }
    return numConns
  }
})

Object.defineProperty(Swarm.prototype, 'numPeers', {
  get: function () {
    var self = this
    return self.wires.length
  }
})

/**
 * Add a peer to the swarm.
 * @param {string|simple-peer} peer    "ip:port" string or simple-peer instance
 * @param {string}             peer.id bittorrent peer id (when `peer` is simple-peer)
 * @return {boolean} true if peer was added, false if peer was invalid

 */
Swarm.prototype.addPeer = function (peer) {
  var self = this
  var newPeer = self._addPeer(peer)
  return !!newPeer // don't expose private Peer instance in return value
}

Swarm.prototype._addPeer = function (peer) {
  var self = this
  if (self.destroyed) {
    debug('ignoring added peer: swarm already destroyed')
    if (typeof peer !== 'string') peer.destroy()
    return null
  }
  if (typeof peer === 'string' && !self._validAddr(peer)) {
    debug('ignoring added peer: invalid address %s', peer)
    return null
  }

  var id = (peer && peer.id) || peer
  if (self._peers[id]) {
    debug('ignoring added peer: duplicate peer id')
    if (typeof peer !== 'string') peer.destroy()
    return null
  }

  if (self.paused) {
    debug('ignoring added peer: swarm paused')
    if (typeof peer !== 'string') peer.destroy()
    return null
  }

  debug('addPeer %s', id)

  var newPeer
  if (typeof peer === 'string') {
    // `peer` is an addr ("ip:port" string)
    newPeer = Peer.createTCPOutgoingPeer(peer, self)
  } else {
    // `peer` is a WebRTC connection (simple-peer)
    newPeer = Peer.createWebRTCPeer(peer, self)
  }

  self._peers[newPeer.id] = newPeer
  self._peersLength += 1

  if (typeof peer === 'string') {
    // `peer` is an addr ("ip:port" string)
    self._queue.push(newPeer)
    self._drain()
  }

  return newPeer
}

/**
 * Add a web seed to the swarm.
 * @param {string} url web seed url
 * @param {Object} parsedTorrent
 */
Swarm.prototype.addWebSeed = function (url, parsedTorrent) {
  var self = this
  if (self.destroyed) return

  if (!/^https?:\/\/.+/.test(url)) {
    debug('ignoring invalid web seed %s (from swarm.addWebSeed)', url)
    return
  }

  if (self._peers[url]) return

  debug('addWebSeed %s', url)

  var newPeer = Peer.createWebSeedPeer(url, parsedTorrent, self)
  self._peers[newPeer.id] = newPeer
  self._peersLength += 1
}

/**
 * Called whenever a new incoming TCP peer connects to this swarm. Called with a peer
 * that has already sent a handshake.
 * @param {Peer} peer
 */
Swarm.prototype._addIncomingPeer = function (peer) {
  var self = this
  if (self.destroyed) return peer.destroy(new Error('swarm already destroyed'))
  if (self.paused) return peer.destroy(new Error('swarm paused'))

  if (!self._validAddr(peer.addr)) {
    return peer.destroy(new Error('invalid addr ' + peer.addr + ' (from incoming)'))
  }
  debug('_addIncomingPeer %s', peer.id)

  self._peers[peer.id] = peer
  self._peersLength += 1
}

/**
 * Remove a peer from the swarm.
 * @param  {string} id for tcp peers, "ip:port" string; for webrtc peers, peerId
 */
Swarm.prototype.removePeer = function (id) {
  var self = this
  var peer = self._peers[id]
  if (!peer) return

  debug('removePeer %s', id)

  delete self._peers[id]
  self._peersLength -= 1

  peer.destroy()

  // If swarm was at capacity before, try to open a new connection now
  self._drain()
}

/**
 * Temporarily stop connecting to new peers. Note that this does not pause the streams
 * of existing connections or their wires.
 */
Swarm.prototype.pause = function () {
  var self = this
  if (self.destroyed) return
  debug('pause')
  self.paused = true
}

/**
 * Resume connecting to new peers.
 */
Swarm.prototype.resume = function () {
  var self = this
  if (self.destroyed) return
  debug('resume')
  self.paused = false
  self._drain()
}

/**
 * Listen on the given port for peer connections.
 * @param {number} port
 * @param {string=} hostname
 * @param {function=} onlistening
 */
Swarm.prototype.listen = function (port, hostname, onlistening) {
  var self = this
  if (typeof hostname === 'function') {
    onlistening = hostname
    hostname = undefined
  }
  if (self.listening) throw new Error('swarm already listening')
  if (onlistening) self.once('listening', onlistening)

  if (typeof TCPPool === 'function') {
    self._port = port || TCPPool.getDefaultListenPort(self.infoHash)
    self._hostname = hostname

    debug('listen %s', port)

    var pool = TCPPool.addSwarm(self)
    self.server = pool.server
  } else {
    // In browser, listen() is no-op, but still fire 'listening' event so that
    // same code works in node and the browser.
    process.nextTick(function () {
      self._onListening(0)
    })
  }
}

Swarm.prototype._onListening = function (port) {
  var self = this
  self._port = port
  self.listening = true
  self.emit('listening')
}

Swarm.prototype.address = function () {
  var self = this
  if (!self.listening) return null
  return self.server
    ? self.server.address()
    : { port: 0, family: 'IPv4', address: '127.0.0.1' }
}

/**
 * Destroy the swarm, close all open peer connections, and do cleanup.
 * @param {function} onclose
 */
Swarm.prototype.destroy = function (onclose) {
  var self = this
  if (self.destroyed) return

  self.destroyed = true
  self.listening = false
  self.paused = false

  if (onclose) self.once('close', onclose)

  debug('destroy')

  for (var id in self._peers) {
    self.removePeer(id)
  }

  if (typeof TCPPool === 'function') {
    TCPPool.removeSwarm(self, function () {
      // TODO: only emit when all peers are destroyed
      self.emit('close')
    })
  } else {
    process.nextTick(function () {
      self.emit('close')
    })
  }
}

/**
 * Pop a peer off the FIFO queue and connect to it. When _drain() gets called,
 * the queue will usually have only one peer in it, except when there are too
 * many peers (over `this.maxConns`) in which case they will just sit in the
 * queue until another connection closes.
 */
Swarm.prototype._drain = function () {
  var self = this
  debug('_drain numConns %s maxConns %s', self.numConns, self.maxConns)
  if (typeof net.connect !== 'function' || self.destroyed || self.paused ||
      self.numConns >= self.maxConns) {
    return
  }
  debug('drain (%s queued, %s/%s peers)', self.numQueued, self.numPeers, self.maxConns)

  var peer = self._queue.shift()
  if (!peer) return // queue could be empty

  debug('tcp connect attempt to %s', peer.addr)

  var parts = addrToIPPort(peer.addr)
  var opts = {
    host: parts[0],
    port: parts[1]
  }
  if (self._hostname) opts.localAddress = self._hostname

  var conn = peer.conn = net.connect(opts)

  conn.once('connect', function () { peer.onConnect() })
  conn.once('error', function (err) { peer.destroy(err) })
  peer.startConnectTimeout()

  // When connection closes, attempt reconnect after timeout (with exponential backoff)
  conn.on('close', function () {
    if (self.destroyed) return

    // TODO: If torrent is done, do not try to reconnect after a timeout

    if (peer.retries >= RECONNECT_WAIT.length) {
      debug(
        'conn %s closed: will not re-add (max %s attempts)',
        peer.addr, RECONNECT_WAIT.length
      )
      return
    }

    var ms = RECONNECT_WAIT[peer.retries]
    debug(
      'conn %s closed: will re-add to queue in %sms (attempt %s)',
      peer.addr, ms, peer.retries + 1
    )

    var reconnectTimeout = setTimeout(function reconnectTimeout () {
      var newPeer = self._addPeer(peer.addr)
      if (newPeer) newPeer.retries = peer.retries + 1
    }, ms)
    if (reconnectTimeout.unref) reconnectTimeout.unref()
  })
}

Swarm.prototype._onError = function (err) {
  var self = this
  self.emit('error', err)
  self.destroy()
}

/**
 * Returns `true` if string is valid IPv4/6 address, and is not the address of this swarm.
 * @param {string} addr
 * @return {boolean}
 */
Swarm.prototype._validAddr = function (addr) {
  var self = this
  var parts
  try {
    parts = addrToIPPort(addr)
  } catch (e) {
    return false
  }
  var host = parts[0]
  var port = parts[1]
  return port > 0 && port < 65535 && !(host === '127.0.0.1' && port === self._port)
}

}).call(this,require('_process'),require("buffer").Buffer)
},{"./peer":4,"./tcp-pool":24,"_process":33,"addr-to-ip-port":9,"buffer":25,"debug":93,"events":29,"inherits":101,"net":24,"speedometer":149}],7:[function(require,module,exports){
(function (process,global){
/* global URL, Blob */

module.exports = Torrent

var addrToIPPort = require('addr-to-ip-port')
var BitField = require('bitfield')
var ChunkStoreWriteStream = require('chunk-store-stream/write')
var debug = require('debug')('webtorrent:torrent')
var Discovery = require('torrent-discovery')
var EventEmitter = require('events').EventEmitter
var extend = require('xtend')
var extendMutable = require('xtend/mutable')
var fs = require('fs')
var FSChunkStore = require('fs-chunk-store') // browser: `memory-chunk-store`
var ImmediateChunkStore = require('immediate-chunk-store')
var inherits = require('inherits')
var MultiStream = require('multistream')
var os = require('os') // browser exclude
var parallel = require('run-parallel')
var parallelLimit = require('run-parallel-limit')
var parseTorrent = require('parse-torrent')
var path = require('path')
var pathExists = require('path-exists') // browser exclude
var Piece = require('torrent-piece')
var pump = require('pump')
var randomIterate = require('random-iterate')
var sha1 = require('simple-sha1')
var uniq = require('uniq')
var ut_metadata = require('ut_metadata')
var ut_pex = require('ut_pex') // browser exclude

var File = require('./file')
var RarityMap = require('./rarity-map')
var Server = require('./server') // browser exclude
var Swarm = require('./swarm')

var MAX_BLOCK_LENGTH = 128 * 1024
var PIECE_TIMEOUT = 30000
var CHOKE_TIMEOUT = 5000
var SPEED_THRESHOLD = 3 * Piece.BLOCK_LENGTH

var PIPELINE_MIN_DURATION = 0.5
var PIPELINE_MAX_DURATION = 1

var RECHOKE_INTERVAL = 10000 // 10 seconds
var RECHOKE_OPTIMISTIC_DURATION = 2 // 30 seconds

var FILESYSTEM_CONCURRENCY = 2

var TMP = typeof pathExists.sync === 'function'
  ? path.join(pathExists.sync('/tmp') ? '/tmp' : os.tmpDir(), 'webtorrent')
  : '/tmp/webtorrent'

inherits(Torrent, EventEmitter)

/**
 * @param {string|Buffer|Object} torrentId
 * @param {WebTorrent} client
 * @param {Object=} opts
 */
function Torrent (torrentId, client, opts) {
  EventEmitter.call(this)

  this.client = client
  this._debugId = this.client.peerId.slice(32)

  this._debug('new torrent')

  this.announce = opts.announce
  this.urlList = opts.urlList

  this.path = opts.path
  this._store = opts.store || FSChunkStore
  this._getAnnounceOpts = opts.getAnnounceOpts

  this.strategy = opts.strategy || 'sequential'

  this.maxWebConns = opts.maxWebConns

  this._rechokeNumSlots = (opts.uploads === false || opts.uploads === 0)
    ? 0
    : (+opts.uploads || 10)
  this._rechokeOptimisticWire = null
  this._rechokeOptimisticTime = 0
  this._rechokeIntervalId = null

  this.ready = false
  this.destroyed = false
  this.metadata = null
  this.store = null
  this.numBlockedPeers = 0
  this.files = null
  this.done = false

  this._amInterested = false
  this.pieces = []
  this._selections = []
  this._critical = []

  // for cleanup
  this._servers = []

  // optimization: don't recheck every file if it hasn't changed
  this._fileModtimes = opts.fileModtimes

  if (torrentId !== null) this._onTorrentId(torrentId)
}

Object.defineProperty(Torrent.prototype, 'timeRemaining', {
  get: function () {
    if (this.done) return 0
    if (this.downloadSpeed === 0) return Infinity
    return ((this.length - this.downloaded) / this.downloadSpeed) * 1000
  }
})

Object.defineProperty(Torrent.prototype, 'downloaded', {
  get: function () {
    if (!this.bitfield) return 0
    var downloaded = 0
    for (var index = 0, len = this.pieces.length; index < len; ++index) {
      if (this.bitfield.get(index)) { // verified data
        downloaded += (index === len - 1) ? this.lastPieceLength : this.pieceLength
      } else { // "in progress" data
        var piece = this.pieces[index]
        downloaded += (piece.length - piece.missing)
      }
    }
    return downloaded
  }
})

Object.defineProperty(Torrent.prototype, 'received', {
  get: function () { return this.swarm ? this.swarm.downloaded : 0 }
})

Object.defineProperty(Torrent.prototype, 'uploaded', {
  get: function () { return this.swarm ? this.swarm.uploaded : 0 }
})

// The number of missing pieces. Used to implement 'end game' mode.
// Object.defineProperty(Storage.prototype, 'numMissing', {
//   get: function () {
//     var self = this
//     var numMissing = self.pieces.length
//     for (var index = 0, len = self.pieces.length; index < len; index++) {
//       numMissing -= self.bitfield.get(index)
//     }
//     return numMissing
//   }
// })

Object.defineProperty(Torrent.prototype, 'downloadSpeed', {
  get: function () { return this.swarm ? this.swarm.downloadSpeed() : 0 }
})

Object.defineProperty(Torrent.prototype, 'uploadSpeed', {
  get: function () { return this.swarm ? this.swarm.uploadSpeed() : 0 }
})

Object.defineProperty(Torrent.prototype, 'progress', {
  get: function () { return this.length ? this.downloaded / this.length : 0 }
})

Object.defineProperty(Torrent.prototype, 'ratio', {
  get: function () { return this.uploaded / (this.downloaded || 1) }
})

Object.defineProperty(Torrent.prototype, 'numPeers', {
  get: function () { return this.swarm ? this.swarm.numPeers : 0 }
})

// TODO: remove this
// Torrent file as a blob url
Object.defineProperty(Torrent.prototype, 'torrentFileBlobURL', {
  get: function () {
    if (typeof window === 'undefined') throw new Error('browser-only property')
    if (!this.torrentFile) return null
    return URL.createObjectURL(
      new Blob([ this.torrentFile ], { type: 'application/x-bittorrent' })
    )
  }
})

Torrent.prototype._onTorrentId = function (torrentId) {
  var self = this
  if (self.destroyed) return

  var parsedTorrent
  try { parsedTorrent = parseTorrent(torrentId) } catch (err) {}

  if (parsedTorrent) {
    // Attempt to set infoHash property synchronously
    self.infoHash = parsedTorrent.infoHash
    process.nextTick(function () {
      if (self.destroyed) return
      self._onParsedTorrent(parsedTorrent)
    })
  } else {
    // If torrentId failed to parse, it could be in a form that requires an async
    // operation, i.e. http/https link, filesystem path, or Blob.
    parseTorrent.remote(torrentId, function (err, parsedTorrent) {
      if (self.destroyed) return
      if (err) return self._onError(err)
      self._onParsedTorrent(parsedTorrent)
    })
  }
}

Torrent.prototype._onParsedTorrent = function (parsedTorrent) {
  var self = this
  if (self.destroyed) return

  self._processParsedTorrent(parsedTorrent)

  if (!self.infoHash) {
    return self._onError(new Error('Malformed torrent data: No info hash'))
  }

  if (!self.path) self.path = path.join(TMP, self.infoHash)

  // create swarm
  self.swarm = new Swarm(self.infoHash, self.client.peerId, {
    handshake: {
      dht: self.private ? false : !!self.client.dht
    },
    maxConns: self.client.maxConns
  })
  self.swarm.on('error', function (err) {
    self._onError(err)
  })
  self.swarm.on('wire', function (wire, addr) {
    self._onWire(wire, addr)
  })

  self.swarm.on('download', function (downloaded) {
    self.client._downloadSpeed(downloaded) // update overall client stats
    self.client.emit('download', downloaded)
    self.emit('download', downloaded)
  })

  self.swarm.on('upload', function (uploaded) {
    self.client._uploadSpeed(uploaded) // update overall client stats
    self.client.emit('upload', uploaded)
    self.emit('upload', uploaded)
  })

  // listen for peers (note: in the browser, this is a no-op and callback is called on
  // next tick)
  self.swarm.listen(self.client.torrentPort, function () {
    self._onSwarmListening()
  })

  self.emit('infoHash', self.infoHash)
}

Torrent.prototype._processParsedTorrent = function (parsedTorrent) {
  if (this.announce) {
    // Allow specifying trackers via `opts` parameter
    parsedTorrent.announce = parsedTorrent.announce.concat(this.announce)
  }

  if (this.client.tracker && global.WEBTORRENT_ANNOUNCE && !this.private) {
    // So `webtorrent-hybrid` can force specific trackers to be used
    parsedTorrent.announce = parsedTorrent.announce.concat(global.WEBTORRENT_ANNOUNCE)
  }

  if (this.urlList) {
    // Allow specifying web seeds via `opts` parameter
    parsedTorrent.urlList = parsedTorrent.urlList.concat(this.urlList)
  }

  uniq(parsedTorrent.announce)
  uniq(parsedTorrent.urlList)

  extendMutable(this, parsedTorrent)

  this.magnetURI = parseTorrent.toMagnetURI(parsedTorrent)
  this.torrentFile = parseTorrent.toTorrentFile(parsedTorrent)
}

Torrent.prototype._onSwarmListening = function () {
  var self = this
  if (self.destroyed) return

  if (self.swarm.server) self.client.torrentPort = self.swarm.address().port

  var trackerOpts = {
    rtcConfig: self.client._rtcConfig,
    wrtc: self.client._wrtc,
    getAnnounceOpts: function () {
      var opts = {
        uploaded: self.uploaded,
        downloaded: self.downloaded,
        left: Math.max(self.length - self.downloaded, 0)
      }
      if (self._getAnnounceOpts) opts = extend(opts, self._getAnnounceOpts())
      return opts
    }
  }

  // begin discovering peers via DHT and trackers
  self.discovery = new Discovery({
    infoHash: self.infoHash,
    announce: self.announce,
    peerId: self.client.peerId,
    dht: !self.private && self.client.dht,
    tracker: self.client.tracker && trackerOpts,
    port: self.client.torrentPort
  })
  self.discovery.on('error', function (err) {
    self._onError(err)
  })
  self.discovery.on('peer', function (peer) {
    // Don't create new outgoing TCP connections when torrent is done
    if (typeof peer === 'string' && self.done) return
    self.addPeer(peer)
  })

  // expose discovery events
  self.discovery.on('trackerAnnounce', function () {
    self.emit('trackerAnnounce')
  })
  self.discovery.on('dhtAnnounce', function () {
    self.emit('dhtAnnounce')
  })
  self.discovery.on('warning', function (err) {
    self.emit('warning', err)
  })

  // if full metadata was included in initial torrent id, use it immediately. Otherwise,
  // wait for torrent-discovery to find peers and ut_metadata to get the metadata.
  if (self.info) self._onMetadata(self)

  self.emit('listening', self.client.torrentPort)
}

/**
 * Called when the full torrent metadata is received.
 */
Torrent.prototype._onMetadata = function (metadata) {
  var self = this
  if (self.metadata || self.destroyed) return
  self._debug('got metadata')

  var parsedTorrent
  if (metadata && metadata.infoHash) {
    // `metadata` is a parsed torrent (from parse-torrent module)
    parsedTorrent = metadata
  } else {
    try {
      parsedTorrent = parseTorrent(metadata)
    } catch (err) {
      return self._onError(err)
    }
  }

  self._processParsedTorrent(parsedTorrent)
  self.metadata = self.torrentFile

  // add web seed urls (BEP19)
  self.urlList.forEach(function (url) {
    self.addWebSeed(url)
  })

  self.rarityMap = new RarityMap(self.swarm, self.pieces.length)

  self.store = new ImmediateChunkStore(
    new self._store(self.pieceLength, {
      torrent: self,
      files: self.files.map(function (file) {
        return {
          path: path.join(self.path, file.path),
          length: file.length,
          offset: file.offset
        }
      }),
      length: self.length
    })
  )

  self.files = self.files.map(function (file) {
    return new File(self, file)
  })

  self._hashes = self.pieces

  self.pieces = self.pieces.map(function (hash, i) {
    var pieceLength = (i === self.pieces.length - 1)
      ? self.lastPieceLength
      : self.pieceLength
    return new Piece(pieceLength)
  })

  self._reservations = self.pieces.map(function () {
    return []
  })

  self.bitfield = new BitField(self.pieces.length)

  self.swarm.wires.forEach(function (wire) {
    // If we didn't have the metadata at the time ut_metadata was initialized for this
    // wire, we still want to make it available to the peer in case they request it.
    if (wire.ut_metadata) wire.ut_metadata.setMetadata(self.metadata)

    self._onWireWithMetadata(wire)
  })

  self._debug('verifying existing torrent data')
  if (self._fileModtimes && self._store === FSChunkStore) {
    // don't verify if the files haven't been modified since we last checked
    self.getFileModtimes(function (err, fileModtimes) {
      if (err) return self._onError(err)

      var unchanged = self.files.map(function (_, index) {
        return fileModtimes[index] === self._fileModtimes[index]
      }).every(function (x) {
        return x
      })

      if (unchanged) {
        for (var index = 0; index < self.pieces.length; index++) {
          self._markVerified(index)
        }
        self._onStore()
      } else {
        self._verifyPieces()
      }
    })
  } else {
    self._verifyPieces()
  }

  self.emit('metadata')
}

/*
 * Gets the last modified time of every file on disk for this torrent.
 * Only valid in Node, not in the browser.
 */
Torrent.prototype.getFileModtimes = function (cb) {
  var self = this
  var ret = []
  parallelLimit(self.files.map(function (file, index) {
    return function (cb) {
      fs.stat(path.join(self.path, file.path), function (err, stat) {
        ret[index] = stat && stat.mtime.getTime()
        cb(err)
      })
    }
  }), FILESYSTEM_CONCURRENCY, function (err) {
    self._debug('done getting file modtimes')
    cb(err, ret)
  })
}

Torrent.prototype._verifyPieces = function () {
  var self = this
  parallelLimit(self.pieces.map(function (_, index) {
    return function (cb) {
      self.store.get(index, function (err, buf) {
        if (err) return cb(null) // ignore error
        sha1(buf, function (hash) {
          if (hash === self._hashes[index]) {
            if (!self.pieces[index]) return
            self._debug('piece verified %s', index)
            self._markVerified(index)
          } else {
            self._debug('piece invalid %s', index)
          }
          cb(null)
        })
      })
    }
  }), FILESYSTEM_CONCURRENCY, function (err) {
    if (err) return self._onError(err)
    self._debug('done verifying')
    self._onStore()
  })
}

Torrent.prototype._markVerified = function (index) {
  this.pieces[index] = null
  this._reservations[index] = null
  this.bitfield.set(index, true)
}

/**
 * Called when the metadata, swarm, and underlying chunk store is initialized.
 */
Torrent.prototype._onStore = function () {
  var self = this
  if (self.destroyed) return
  self._debug('on store')

  // start off selecting the entire torrent with low priority
  self.select(0, self.pieces.length - 1, false)

  self._rechokeIntervalId = setInterval(function () {
    self._rechoke()
  }, RECHOKE_INTERVAL)
  if (self._rechokeIntervalId.unref) self._rechokeIntervalId.unref()

  self.ready = true
  self.emit('ready')

  self._checkDone()
}

/**
 * Destroy and cleanup this torrent.
 */
Torrent.prototype.destroy = function (cb) {
  var self = this
  if (self.destroyed) return
  self.destroyed = true
  self._debug('destroy')

  self.client.remove(self)

  if (self._rechokeIntervalId) {
    clearInterval(self._rechokeIntervalId)
    self._rechokeIntervalId = null
  }

  var tasks = []

  self._servers.forEach(function (server) {
    tasks.push(function (cb) { server.destroy(cb) })
  })

  if (self.swarm) tasks.push(function (cb) { self.swarm.destroy(cb) })
  if (self.discovery) tasks.push(function (cb) { self.discovery.destroy(cb) })
  if (self.store) tasks.push(function (cb) { self.store.close(cb) })

  parallel(tasks, cb)
}

/**
 * Add a peer to the swarm
 * @param {string|SimplePeer} peer
 * @return {boolean} true if peer was added, false if peer was blocked
 */
Torrent.prototype.addPeer = function (peer) {
  var self = this
  if (self.destroyed) throw new Error('torrent is destroyed')

  function addPeer () {
    var wasAdded = self.swarm.addPeer(peer)
    if (wasAdded) {
      self.emit('peer', peer)
    } else {
      self.emit('invalidPeer', peer)
    }
  }

  if (self.client.blocked) {
    var host
    if (typeof peer === 'string') {
      var parts
      try {
        parts = addrToIPPort(peer)
      } catch (e) {
        self.emit('invalidPeer', peer)
        return false
      }
      host = parts[0]
    } else if (typeof peer.remoteAddress === 'string') {
      host = peer.remoteAddress
    }

    if (host && self.client.blocked.contains(host)) {
      self.numBlockedPeers += 1 // TODO: remove this. less api surface area
      self.emit('blockedPeer', peer)
      return false
    }
  }

  if (self.swarm) addPeer()
  else self.once('listening', addPeer)
  return true
}

/**
 * Add a web seed to the swarm
 * @param {string} url web seed url
 */
Torrent.prototype.addWebSeed = function (url) {
  if (this.destroyed) throw new Error('torrent is destroyed')
  this._debug('add web seed %s', url)
  this.swarm.addWebSeed(url, this)
}

/**
 * Select a range of pieces to prioritize.
 *
 * @param {number}    start     start piece index (inclusive)
 * @param {number}    end       end piece index (inclusive)
 * @param {number}    priority  priority associated with this selection
 * @param {function}  notify    callback when selection is updated with new data
 */
Torrent.prototype.select = function (start, end, priority, notify) {
  var self = this
  if (self.destroyed) throw new Error('torrent is destroyed')

  if (start > end || start < 0 || end >= self.pieces.length) {
    throw new Error('invalid selection ', start, ':', end)
  }
  priority = Number(priority) || 0

  self._debug('select %s-%s (priority %s)', start, end, priority)

  self._selections.push({
    from: start,
    to: end,
    offset: 0,
    priority: priority,
    notify: notify || noop
  })

  self._selections.sort(function (a, b) {
    return b.priority - a.priority
  })

  self._updateSelections()
}

/**
 * Deprioritizes a range of previously selected pieces.
 *
 * @param {number}  start     start piece index (inclusive)
 * @param {number}  end       end piece index (inclusive)
 * @param {number}  priority  priority associated with the selection
 */
Torrent.prototype.deselect = function (start, end, priority) {
  var self = this
  if (self.destroyed) throw new Error('torrent is destroyed')

  priority = Number(priority) || 0
  self._debug('deselect %s-%s (priority %s)', start, end, priority)

  for (var i = 0; i < self._selections.length; ++i) {
    var s = self._selections[i]
    if (s.from === start && s.to === end && s.priority === priority) {
      self._selections.splice(i--, 1)
      break
    }
  }

  self._updateSelections()
}

/**
 * Marks a range of pieces as critical priority to be downloaded ASAP.
 *
 * @param {number}  start  start piece index (inclusive)
 * @param {number}  end    end piece index (inclusive)
 */
Torrent.prototype.critical = function (start, end) {
  var self = this
  if (self.destroyed) throw new Error('torrent is destroyed')

  self._debug('critical %s-%s', start, end)

  for (var i = start; i <= end; ++i) {
    self._critical[i] = true
  }

  self._updateSelections()
}

Torrent.prototype._onWire = function (wire, addr) {
  var self = this
  self._debug('got wire %s (%s)', wire._debugId, addr || 'Unknown')

  if (addr) {
    // Sometimes RTCPeerConnection.getStats() doesn't return an ip:port for peers
    var parts = addrToIPPort(addr)
    wire.remoteAddress = parts[0]
    wire.remotePort = parts[1]
  }

  // When peer sends PORT message, add that DHT node to routing table
  if (self.client.dht && self.client.dht.listening) {
    wire.on('port', function (port) {
      if (self.destroyed || self.client.dht.destroyed) {
        return
      }
      if (!wire.remoteAddress) {
        return self._debug('ignoring PORT from peer with no address')
      }
      if (port === 0 || port > 65536) {
        return self._debug('ignoring invalid PORT from peer')
      }

      self._debug('port: %s (from %s)', port, addr)
      self.client.dht.addNode({ host: wire.remoteAddress, port: port })
    })
  }

  wire.on('timeout', function () {
    self._debug('wire timeout (%s)', addr)
    // TODO: this might be destroying wires too eagerly
    wire.destroy()
  })

  // Timeout for piece requests to this peer
  wire.setTimeout(PIECE_TIMEOUT, true)

  // Send KEEP-ALIVE (every 60s) so peers will not disconnect the wire
  wire.setKeepAlive(true)

  // use ut_metadata extension
  wire.use(ut_metadata(self.metadata))

  wire.ut_metadata.on('warning', function (err) {
    self._debug('ut_metadata warning: %s', err.message)
  })

  if (!self.metadata) {
    wire.ut_metadata.on('metadata', function (metadata) {
      self._debug('got metadata via ut_metadata')
      self._onMetadata(metadata)
    })
    wire.ut_metadata.fetch()
  }

  // use ut_pex extension if the torrent is not flagged as private
  if (typeof ut_pex === 'function' && !self.private) {
    wire.use(ut_pex())

    wire.ut_pex.on('peer', function (peer) {
      // Only add potential new peers when we're not seeding
      if (self.done) return
      self._debug('ut_pex: got peer: %s (from %s)', peer, addr)
      self.addPeer(peer)
    })

    wire.ut_pex.on('dropped', function (peer) {
      // the remote peer believes a given peer has been dropped from the swarm.
      // if we're not currently connected to it, then remove it from the swarm's queue.
      var peerObj = self.swarm._peers[peer]
      if (peerObj && !peerObj.connected) {
        self._debug('ut_pex: dropped peer: %s (from %s)', peer, addr)
        self.swarm.removePeer(peer)
      }
    })

    wire.once('close', function () {
      // Stop sending updates to remote peer
      wire.ut_pex.reset()
    })
  }

  // Hook to allow user-defined `bittorrent-protocol` extensions
  // More info: https://github.com/feross/bittorrent-protocol#extension-api
  self.emit('wire', wire, addr)

  if (self.metadata) {
    process.nextTick(function () {
      // nextTick allows wire.handshake() to be called by `bittorrent-swarm`
      // first, before we send any other messages on the wire
      self._onWireWithMetadata(wire)
    })
  }
}

Torrent.prototype._onWireWithMetadata = function (wire) {
  var self = this
  var timeoutId = null

  function onChokeTimeout () {
    if (self.destroyed || wire.destroyed) return

    if (self.swarm.numQueued > 2 * (self.swarm.numConns - self.swarm.numPeers) &&
      wire.amInterested) {
      wire.destroy()
    } else {
      timeoutId = setTimeout(onChokeTimeout, CHOKE_TIMEOUT)
      if (timeoutId.unref) timeoutId.unref()
    }
  }

  var i = 0
  function updateSeedStatus () {
    if (wire.peerPieces.length !== self.pieces.length) return
    for (; i < self.pieces.length; ++i) {
      if (!wire.peerPieces.get(i)) return
    }
    wire.isSeeder = true
    wire.choke() // always choke seeders
  }

  wire.on('bitfield', function () {
    updateSeedStatus()
    self._update()
  })

  wire.on('have', function () {
    updateSeedStatus()
    self._update()
  })

  wire.once('interested', function () {
    wire.unchoke()
  })

  wire.once('close', function () {
    clearTimeout(timeoutId)
  })

  wire.on('choke', function () {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(onChokeTimeout, CHOKE_TIMEOUT)
    if (timeoutId.unref) timeoutId.unref()
  })

  wire.on('unchoke', function () {
    clearTimeout(timeoutId)
    self._update()
  })

  wire.on('request', function (index, offset, length, cb) {
    if (length > MAX_BLOCK_LENGTH) {
      // Per spec, disconnect from peers that request >128KB
      return wire.destroy()
    }
    if (self.pieces[index]) return
    self.store.get(index, { offset: offset, length: length }, cb)
  })

  wire.bitfield(self.bitfield) // always send bitfield (required)
  wire.interested() // always start out interested

  // Send PORT message to peers that support DHT
  if (wire.peerExtensions.dht && self.client.dht && self.client.dht.listening) {
    wire.port(self.client.dht.address().port)
  }

  timeoutId = setTimeout(onChokeTimeout, CHOKE_TIMEOUT)
  if (timeoutId.unref) timeoutId.unref()

  wire.isSeeder = false
  updateSeedStatus()
}

/**
 * Called on selection changes.
 */
Torrent.prototype._updateSelections = function () {
  var self = this
  if (!self.swarm || self.destroyed) return
  if (!self.metadata) {
    self.once('metadata', function () {
      self._updateSelections()
    })
    return
  }

  process.nextTick(function () {
    self._gcSelections()
  })
  self._updateInterest()
  self._update()
}

/**
 * Garbage collect selections with respect to the store's current state.
 */
Torrent.prototype._gcSelections = function () {
  var self = this

  for (var i = 0; i < self._selections.length; i++) {
    var s = self._selections[i]
    var oldOffset = s.offset

    // check for newly downloaded pieces in selection
    while (self.bitfield.get(s.from + s.offset) && s.from + s.offset < s.to) {
      s.offset++
    }

    if (oldOffset !== s.offset) s.notify()
    if (s.to !== s.from + s.offset) continue
    if (!self.bitfield.get(s.from + s.offset)) continue

    // remove fully downloaded selection
    self._selections.splice(i--, 1) // decrement i to offset splice
    s.notify() // TODO: this may notify twice in a row. is this a problem?
    self._updateInterest()
  }

  if (!self._selections.length) self.emit('idle')
}

/**
 * Update interested status for all peers.
 */
Torrent.prototype._updateInterest = function () {
  var self = this

  var prev = self._amInterested
  self._amInterested = !!self._selections.length

  self.swarm.wires.forEach(function (wire) {
    // TODO: only call wire.interested if the wire has at least one piece we need
    if (self._amInterested) wire.interested()
    else wire.uninterested()
  })

  if (prev === self._amInterested) return
  if (self._amInterested) self.emit('interested')
  else self.emit('uninterested')
}

/**
 * Heartbeat to update all peers and their requests.
 */
Torrent.prototype._update = function () {
  var self = this
  if (self.destroyed) return

  // update wires in random order for better request distribution
  var ite = randomIterate(self.swarm.wires)
  var wire
  while ((wire = ite())) {
    self._updateWire(wire)
  }
}

/**
 * Attempts to update a peer's requests
 */
Torrent.prototype._updateWire = function (wire) {
  var self = this

  if (wire.peerChoking) return
  if (!wire.downloaded) return validateWire()

  var minOutstandingRequests = getPipelineLength(wire, PIPELINE_MIN_DURATION)
  if (wire.requests.length >= minOutstandingRequests) return
  var maxOutstandingRequests = getPipelineLength(wire, PIPELINE_MAX_DURATION)

  trySelectWire(false) || trySelectWire(true)

  function genPieceFilterFunc (start, end, tried, rank) {
    return function (i) {
      return i >= start && i <= end && !(i in tried) && wire.peerPieces.get(i) && (!rank || rank(i))
    }
  }

  // TODO: Do we need both validateWire and trySelectWire?
  function validateWire () {
    if (wire.requests.length) return

    var i = self._selections.length
    while (i--) {
      var next = self._selections[i]
      var piece
      if (self.strategy === 'rarest') {
        var start = next.from + next.offset
        var end = next.to
        var len = end - start + 1
        var tried = {}
        var tries = 0
        var filter = genPieceFilterFunc(start, end, tried)

        while (tries < len) {
          piece = self.rarityMap.getRarestPiece(filter)
          if (piece < 0) break
          if (self._request(wire, piece, false)) return
          tried[piece] = true
          tries += 1
        }
      } else {
        for (piece = next.to; piece >= next.from + next.offset; --piece) {
          if (!wire.peerPieces.get(piece)) continue
          if (self._request(wire, piece, false)) return
        }
      }
    }

    // TODO: wire failed to validate as useful; should we close it?
    // probably not, since 'have' and 'bitfield' messages might be coming
  }

  function speedRanker () {
    var speed = wire.downloadSpeed() || 1
    if (speed > SPEED_THRESHOLD) return function () { return true }

    var secs = Math.max(1, wire.requests.length) * Piece.BLOCK_LENGTH / speed
    var tries = 10
    var ptr = 0

    return function (index) {
      if (!tries || self.bitfield.get(index)) return true

      var missing = self.pieces[index].missing

      for (; ptr < self.swarm.wires.length; ptr++) {
        var otherWire = self.swarm.wires[ptr]
        var otherSpeed = otherWire.downloadSpeed()

        if (otherSpeed < SPEED_THRESHOLD) continue
        if (otherSpeed <= speed) continue
        if (!otherWire.peerPieces.get(index)) continue
        if ((missing -= otherSpeed * secs) > 0) continue

        tries--
        return false
      }

      return true
    }
  }

  function shufflePriority (i) {
    var last = i
    for (var j = i; j < self._selections.length && self._selections[j].priority; j++) {
      last = j
    }
    var tmp = self._selections[i]
    self._selections[i] = self._selections[last]
    self._selections[last] = tmp
  }

  function trySelectWire (hotswap) {
    if (wire.requests.length >= maxOutstandingRequests) return true
    var rank = speedRanker()

    for (var i = 0; i < self._selections.length; i++) {
      var next = self._selections[i]

      var piece
      if (self.strategy === 'rarest') {
        var start = next.from + next.offset
        var end = next.to
        var len = end - start + 1
        var tried = {}
        var tries = 0
        var filter = genPieceFilterFunc(start, end, tried, rank)

        while (tries < len) {
          piece = self.rarityMap.getRarestPiece(filter)
          if (piece < 0) break

          // request all non-reserved blocks in this piece
          while (self._request(wire, piece, self._critical[piece] || hotswap)) {}

          if (wire.requests.length < maxOutstandingRequests) {
            tried[piece] = true
            tries++
            continue
          }

          if (next.priority) shufflePriority(i)
          return true
        }
      } else {
        for (piece = next.from + next.offset; piece <= next.to; piece++) {
          if (!wire.peerPieces.get(piece) || !rank(piece)) continue

          // request all non-reserved blocks in piece
          while (self._request(wire, piece, self._critical[piece] || hotswap)) {}

          if (wire.requests.length < maxOutstandingRequests) continue

          if (next.priority) shufflePriority(i)
          return true
        }
      }
    }

    return false
  }
}

/**
 * Called periodically to update the choked status of all peers, handling optimistic
 * unchoking as described in BEP3.
 */
Torrent.prototype._rechoke = function () {
  var self = this

  if (self._rechokeOptimisticTime > 0) self._rechokeOptimisticTime -= 1
  else self._rechokeOptimisticWire = null

  var peers = []

  self.swarm.wires.forEach(function (wire) {
    if (!wire.isSeeder && wire !== self._rechokeOptimisticWire) {
      peers.push({
        wire: wire,
        downloadSpeed: wire.downloadSpeed(),
        uploadSpeed: wire.uploadSpeed(),
        salt: Math.random(),
        isChoked: true
      })
    }
  })

  peers.sort(rechokeSort)

  var unchokeInterested = 0
  var i = 0
  for (; i < peers.length && unchokeInterested < self._rechokeNumSlots; ++i) {
    peers[i].isChoked = false
    if (peers[i].wire.peerInterested) unchokeInterested += 1
  }

  // Optimistically unchoke a peer
  if (!self._rechokeOptimisticWire && i < peers.length && self._rechokeNumSlots) {
    var candidates = peers.slice(i).filter(function (peer) { return peer.wire.peerInterested })
    var optimistic = candidates[randomInt(candidates.length)]

    if (optimistic) {
      optimistic.isChoked = false
      self._rechokeOptimisticWire = optimistic.wire
      self._rechokeOptimisticTime = RECHOKE_OPTIMISTIC_DURATION
    }
  }

  // Unchoke best peers
  peers.forEach(function (peer) {
    if (peer.wire.amChoking !== peer.isChoked) {
      if (peer.isChoked) peer.wire.choke()
      else peer.wire.unchoke()
    }
  })

  function rechokeSort (peerA, peerB) {
    // Prefer higher download speed
    if (peerA.downloadSpeed !== peerB.downloadSpeed) {
      return peerB.downloadSpeed - peerA.downloadSpeed
    }

    // Prefer higher upload speed
    if (peerA.uploadSpeed !== peerB.uploadSpeed) {
      return peerB.uploadSpeed - peerA.uploadSpeed
    }

    // Prefer unchoked
    if (peerA.wire.amChoking !== peerB.wire.amChoking) {
      return peerA.wire.amChoking ? 1 : -1
    }

    // Random order
    return peerA.salt - peerB.salt
  }
}

/**
 * Attempts to cancel a slow block request from another wire such that the
 * given wire may effectively swap out the request for one of its own.
 */
Torrent.prototype._hotswap = function (wire, index) {
  var self = this

  var speed = wire.downloadSpeed()
  if (speed < Piece.BLOCK_LENGTH) return false
  if (!self._reservations[index]) return false

  var r = self._reservations[index]
  if (!r) {
    return false
  }

  var minSpeed = Infinity
  var minWire

  var i
  for (i = 0; i < r.length; i++) {
    var otherWire = r[i]
    if (!otherWire || otherWire === wire) continue

    var otherSpeed = otherWire.downloadSpeed()
    if (otherSpeed >= SPEED_THRESHOLD) continue
    if (2 * otherSpeed > speed || otherSpeed > minSpeed) continue

    minWire = otherWire
    minSpeed = otherSpeed
  }

  if (!minWire) return false

  for (i = 0; i < r.length; i++) {
    if (r[i] === minWire) r[i] = null
  }

  for (i = 0; i < minWire.requests.length; i++) {
    var req = minWire.requests[i]
    if (req.piece !== index) continue

    self.pieces[index].cancel((req.offset / Piece.BLOCK_SIZE) | 0)
  }

  self.emit('hotswap', minWire, wire, index)
  return true
}

/**
 * Attempts to request a block from the given wire.
 */
Torrent.prototype._request = function (wire, index, hotswap) {
  var self = this
  var numRequests = wire.requests.length
  var isWebSeed = wire.type === 'webSeed'

  if (self.bitfield.get(index)) return false

  var maxOutstandingRequests = getPipelineLength(wire, PIPELINE_MAX_DURATION)
  if (isWebSeed) {
    // A webseed will handle it's real max requests
    if (maxOutstandingRequests > 2) maxOutstandingRequests -= 2
    if (self.maxWebConns) maxOutstandingRequests = Math.min(maxOutstandingRequests, self.maxWebConns)
  }
  if (numRequests >= maxOutstandingRequests) return false
  // var endGame = (wire.requests.length === 0 && self.store.numMissing < 30)

  var piece = self.pieces[index]
  var reservation = isWebSeed ? piece.reserveRemaining() : piece.reserve()

  if (reservation === -1 && hotswap && self._hotswap(wire, index)) {
    reservation = isWebSeed ? piece.reserveRemaining() : piece.reserve()
  }
  if (reservation === -1) return false

  var r = self._reservations[index]
  if (!r) r = self._reservations[index] = []
  var i = r.indexOf(null)
  if (i === -1) i = r.length
  r[i] = wire

  var chunkOffset = piece.chunkOffset(reservation)
  var chunkLength = isWebSeed ? piece.chunkLengthRemaining(reservation) : piece.chunkLength(reservation)

  wire.request(index, chunkOffset, chunkLength, function onChunk (err, chunk) {
    // TODO: what is this for?
    if (!self.ready) return self.once('ready', function () { onChunk(err, chunk) })

    if (r[i] === wire) r[i] = null

    if (piece !== self.pieces[index]) return onUpdateTick()

    if (err) {
      self._debug(
        'error getting piece %s (offset: %s length: %s) from %s: %s',
        index, chunkOffset, chunkLength, wire.remoteAddress + ':' + wire.remotePort,
        err.message
      )
      isWebSeed ? piece.cancelRemaining(reservation) : piece.cancel(reservation)
      onUpdateTick()
      return
    }

    self._debug(
      'got piece %s (offset: %s length: %s) from %s',
      index, chunkOffset, chunkLength, wire.remoteAddress + ':' + wire.remotePort
    )

    if (!piece.set(reservation, chunk, wire)) return onUpdateTick()

    var buf = piece.flush()

    // TODO: might need to set self.pieces[index] = null here since sha1 is async

    sha1(buf, function (hash) {
      if (hash === self._hashes[index]) {
        if (!self.pieces[index]) return
        self._debug('piece verified %s', index)

        self.pieces[index] = null
        self._reservations[index] = null
        self.bitfield.set(index, true)

        self.store.put(index, buf)

        self.swarm.wires.forEach(function (wire) {
          wire.have(index)
        })

        self._checkDone()
      } else {
        self.pieces[index] = new Piece(piece.length)
        self.emit('warning', new Error('Piece ' + index + ' failed verification'))
      }
      onUpdateTick()
    })
  })

  function onUpdateTick () {
    process.nextTick(function () { self._update() })
  }

  return true
}

Torrent.prototype._checkDone = function () {
  var self = this
  if (self.destroyed) return

  // are any new files done?
  self.files.forEach(function (file) {
    if (file.done) return
    for (var i = file._startPiece; i <= file._endPiece; ++i) {
      if (!self.bitfield.get(i)) return
    }
    file.done = true
    file.emit('done')
    self._debug('file done: ' + file.name)
  })

  // is the torrent done? (if all current selections are satisfied, or there are
  // no selections, then torrent is done)
  var done = true
  for (var i = 0; i < self._selections.length; i++) {
    var selection = self._selections[i]
    for (var piece = selection.from; piece <= selection.to; piece++) {
      if (!self.bitfield.get(piece)) {
        done = false
        break
      }
    }
    if (!done) break
  }
  if (!self.done && done) {
    self.done = true
    self.emit('done')
    self._debug('torrent done: ' + self.infoHash)
    if (self.discovery.tracker) self.discovery.tracker.complete()
  }

  self._gcSelections()
}

Torrent.prototype.load = function (streams, cb) {
  var self = this
  if (self.destroyed) throw new Error('torrent is destroyed')
  if (!self.ready) return self.once('ready', function () { self.load(streams, cb) })

  if (!Array.isArray(streams)) streams = [ streams ]
  if (!cb) cb = noop

  var readable = new MultiStream(streams)
  var writable = new ChunkStoreWriteStream(self.store, self.pieceLength)

  pump(readable, writable, function (err) {
    if (err) return cb(err)
    self.pieces.forEach(function (piece, index) {
      self.pieces[index] = null
      self._reservations[index] = null
      self.bitfield.set(index, true)
    })
    self._checkDone()
    cb(null)
  })
}

Torrent.prototype.createServer = function (opts) {
  if (typeof Server !== 'function') throw new Error('node.js-only method')
  if (this.destroyed) throw new Error('torrent is destroyed')
  var server = new Server(this, opts)
  this._servers.push(server)
  return server
}

Torrent.prototype.pause = function () {
  if (this.destroyed) return
  this.swarm.pause()
}

Torrent.prototype.resume = function () {
  if (this.destroyed) return
  this.swarm.resume()
}

Torrent.prototype._onError = function (err) {
  var self = this
  self._debug('torrent error: %s', err.message || err)
  self.destroy()
  self.emit('error', err)
}

Torrent.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args[0] = '[' + this._debugId + '] ' + args[0]
  debug.apply(null, args)
}

function getPipelineLength (wire, duration) {
  return Math.ceil(2 + duration * wire.downloadSpeed() / Piece.BLOCK_LENGTH)
}

/**
 * Returns a random integer in [0,high)
 */
function randomInt (high) {
  return Math.random() * high | 0
}

function noop () {}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./file":3,"./rarity-map":5,"./server":24,"./swarm":6,"_process":33,"addr-to-ip-port":9,"bitfield":10,"chunk-store-stream/write":60,"debug":93,"events":29,"fs":23,"fs-chunk-store":103,"immediate-chunk-store":100,"inherits":101,"multistream":104,"os":24,"parse-torrent":105,"path":32,"path-exists":24,"pump":117,"random-iterate":120,"run-parallel":139,"run-parallel-limit":138,"simple-sha1":147,"torrent-discovery":156,"torrent-piece":157,"uniq":158,"ut_metadata":160,"ut_pex":24,"xtend":172,"xtend/mutable":173}],8:[function(require,module,exports){
(function (Buffer){
module.exports = WebConn

var BitField = require('bitfield')
var debug = require('debug')('webtorrent:webconn')
var get = require('simple-get')
var inherits = require('inherits')
var sha1 = require('simple-sha1')
var Wire = require('bittorrent-protocol')

inherits(WebConn, Wire)

/**
 * Converts requests for torrent blocks into http range requests.
 * @param {string} url web seed url
 * @param {Object} parsedTorrent
 */
function WebConn (url, parsedTorrent) {
  var self = this
  Wire.call(this)

  self.url = url
  self.webPeerId = sha1.sync(url)
  self.parsedTorrent = parsedTorrent

  self.setKeepAlive(true)

  self.on('handshake', function (infoHash, peerId) {
    self.handshake(infoHash, self.webPeerId)
    var numPieces = self.parsedTorrent.pieces.length
    var bitfield = new BitField(numPieces)
    for (var i = 0; i <= numPieces; i++) {
      bitfield.set(i, true)
    }
    self.bitfield(bitfield)
  })

  self.on('choke', function () { debug('choke') })
  self.on('unchoke', function () { debug('unchoke') })

  self.once('interested', function () {
    debug('interested')
    self.unchoke()
  })
  self.on('uninterested', function () { debug('uninterested') })

  self.on('bitfield', function () { debug('bitfield') })

  self.on('request', function (pieceIndex, offset, length, callback) {
    debug('request pieceIndex=%d offset=%d length=%d', pieceIndex, offset, length)
    self.httpRequest(pieceIndex, offset, length, callback)
  })
}

WebConn.prototype.httpRequest = function (pieceIndex, offset, length, cb) {
  var self = this
  var pieceOffset = pieceIndex * self.parsedTorrent.pieceLength
  var rangeStart = pieceOffset + offset /* offset within whole torrent */
  var rangeEnd = rangeStart + length - 1

  // Web seed URL format
  // For single-file torrents, you just make HTTP range requests directly to the web seed URL
  // For multi-file torrents, you have to add the torrent folder and file name to the URL
  var files = self.parsedTorrent.files
  var requests
  if (files.length <= 1) {
    requests = [{
      url: self.url,
      start: rangeStart,
      end: rangeEnd
    }]
  } else {
    var requestedFiles = files.filter(function (file) {
      return file.offset <= rangeEnd && (file.offset + file.length) > rangeStart
    })
    if (requestedFiles.length < 1) return cb(new Error('Could not find file corresponnding to web seed range request'))

    requests = requestedFiles.map(function (requestedFile) {
      var fileEnd = requestedFile.offset + requestedFile.length - 1
      var url = self.url +
        (self.url[self.url.length - 1] === '/' ? '' : '/') +
        requestedFile.path
      return {
        url: url,
        fileOffsetInRange: Math.max(requestedFile.offset - rangeStart, 0),
        start: Math.max(rangeStart - requestedFile.offset, 0),
        end: Math.min(fileEnd, rangeEnd - requestedFile.offset)
      }
    })
  }

  // Now make all the HTTP requests we need in order to load this piece
  // Usually that's one requests, but sometimes it will be multiple
  // Send requests in parallel and wait for them all to come back
  var numRequestsSucceeded = 0
  var hasError = false
  if (requests.length > 1) var ret = new Buffer(length)
  requests.forEach(function (request) {
    var url = request.url
    var start = request.start
    var end = request.end
    debug(
      'Requesting url=%s pieceIndex=%d offset=%d length=%d start=%d end=%d',
      url, pieceIndex, offset, length, start, end
    )
    var opts = {
      url: url,
      method: 'GET',
      headers: {
        'user-agent': 'WebTorrent (http://webtorrent.io)',
        'range': 'bytes=' + start + '-' + end
      }
    }
    get.concat(opts, function (err, res, data) {
      if (hasError) return
      if (err) {
        hasError = true
        return cb(err)
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        hasError = true
        return cb(new Error('Unexpected HTTP status code ' + res.statusCode))
      }
      debug('Got data of length %d', data.length)
      if (requests.length === 1) {
        // Common case: fetch piece in a single HTTP request, return directly
        return cb(null, data)
      }
      // Rare case: reconstruct multiple HTTP requests across 2+ files into one piece buffer
      data.copy(ret, request.fileOffsetInRange)
      if (++numRequestsSucceeded === requests.length) {
        cb(null, ret)
      }
    })
  })
}

}).call(this,require("buffer").Buffer)
},{"bitfield":10,"bittorrent-protocol":11,"buffer":25,"debug":93,"inherits":101,"simple-get":140,"simple-sha1":147}],9:[function(require,module,exports){
var ADDR_RE = /^\[?([^\]]+)\]?:(\d+)$/ // ipv4/ipv6/hostname + port

var cache = {}

// reset cache when it gets to 100,000 elements (~ 600KB of ipv4 addresses)
// so it will not grow to consume all memory in long-running processes
var size = 0

module.exports = function addrToIPPort (addr) {
  if (size === 100000) module.exports.reset()
  if (!cache[addr]) {
    var m = ADDR_RE.exec(addr)
    if (!m) throw new Error('invalid addr: ' + addr)
    cache[addr] = [ m[1], Number(m[2]) ]
    size += 1
  }
  return cache[addr]
}

module.exports.reset = function reset () {
  cache = {}
  size = 0
}

},{}],10:[function(require,module,exports){
(function (Buffer){
var Container = typeof Buffer !== "undefined" ? Buffer //in node, use buffers
		: typeof Int8Array !== "undefined" ? Int8Array //in newer browsers, use webgl int8arrays
		: function(l){ var a = new Array(l); for(var i = 0; i < l; i++) a[i]=0; }; //else, do something similar

function BitField(data, opts){
	if(!(this instanceof BitField)) {
		return new BitField(data, opts);
	}

	if(arguments.length === 0){
		data = 0;
	}

	this.grow = opts && (isFinite(opts.grow) && getByteSize(opts.grow) || opts.grow) || 0;

	if(typeof data === "number" || data === undefined){
		data = new Container(getByteSize(data));
		if(data.fill && !data._isBuffer) data.fill(0); // clear node buffers of garbage
	}
	this.buffer = data;
}

function getByteSize(num){
	var out = num >> 3;
	if(num % 8 !== 0) out++;
	return out;
}

BitField.prototype.get = function(i){
	var j = i >> 3;
	return (j < this.buffer.length) &&
		!!(this.buffer[j] & (128 >> (i % 8)));
};

BitField.prototype.set = function(i, b){
	var j = i >> 3;
	if (b || arguments.length === 1){
		if (this.buffer.length < j + 1) this._grow(Math.max(j + 1, Math.min(2 * this.buffer.length, this.grow)));
		// Set
		this.buffer[j] |= 128 >> (i % 8);
	} else if (j < this.buffer.length) {
		/// Clear
		this.buffer[j] &= ~(128 >> (i % 8));
	}
};

BitField.prototype._grow = function(length) {
	if (this.buffer.length < length && length <= this.grow) {
		var newBuffer = new Container(length);
		if (newBuffer.fill) newBuffer.fill(0);
		if (this.buffer.copy) this.buffer.copy(newBuffer, 0);
		else {
			for(var i = 0; i < this.buffer.length; i++) {
				newBuffer[i] = this.buffer[i];
			}
		}
		this.buffer = newBuffer;
	}
};

if(typeof module !== "undefined") module.exports = BitField;

}).call(this,require("buffer").Buffer)
},{"buffer":25}],11:[function(require,module,exports){
(function (Buffer){
module.exports = Wire

var bencode = require('bencode')
var BitField = require('bitfield')
var debug = require('debug')('bittorrent-protocol')
var extend = require('xtend')
var hat = require('hat')
var inherits = require('inherits')
var speedometer = require('speedometer')
var stream = require('readable-stream')

var BITFIELD_GROW = 400000
var KEEP_ALIVE_TIMEOUT = 55000

var MESSAGE_PROTOCOL = new Buffer('\u0013BitTorrent protocol')
var MESSAGE_KEEP_ALIVE = new Buffer([0x00, 0x00, 0x00, 0x00])
var MESSAGE_CHOKE = new Buffer([0x00, 0x00, 0x00, 0x01, 0x00])
var MESSAGE_UNCHOKE = new Buffer([0x00, 0x00, 0x00, 0x01, 0x01])
var MESSAGE_INTERESTED = new Buffer([0x00, 0x00, 0x00, 0x01, 0x02])
var MESSAGE_UNINTERESTED = new Buffer([0x00, 0x00, 0x00, 0x01, 0x03])

var MESSAGE_RESERVED = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
var MESSAGE_PORT = [0x00, 0x00, 0x00, 0x03, 0x09, 0x00, 0x00]

function Request (piece, offset, length, callback) {
  this.piece = piece
  this.offset = offset
  this.length = length
  this.callback = callback
}

inherits(Wire, stream.Duplex)

function Wire () {
  if (!(this instanceof Wire)) return new Wire()
  stream.Duplex.call(this)

  this._debugId = hat(32)
  this._debug('new wire')

  this.peerId = null // remote peer id (hex string)
  this.peerIdBuffer = null // remote peer id (buffer)
  this.type = null // connection type ('webrtc', 'tcpIncoming', 'tcpOutgoing', 'webSeed')

  this.amChoking = true // are we choking the peer?
  this.amInterested = false // are we interested in the peer?

  this.peerChoking = true // is the peer choking us?
  this.peerInterested = false // is the peer interested in us?

  // The largest torrent that I know of (the Geocities archive) is ~641 GB and has
  // ~41,000 pieces. Therefore, cap bitfield to 10x larger (400,000 bits) to support all
  // possible torrents but prevent malicious peers from growing bitfield to fill memory.
  this.peerPieces = new BitField(0, { grow: BITFIELD_GROW })

  this.peerExtensions = {}

  this.requests = [] // outgoing
  this.peerRequests = [] // incoming

  this.extendedMapping = {} // number -> string, ex: 1 -> 'ut_metadata'
  this.peerExtendedMapping = {} // string -> number, ex: 9 -> 'ut_metadata'

  // The extended handshake to send, minus the "m" field, which gets automatically
  // filled from `this.extendedMapping`
  this.extendedHandshake = {}

  this.peerExtendedHandshake = {} // remote peer's extended handshake

  this._ext = {}  // string -> function, ex 'ut_metadata' -> ut_metadata()
  this._nextExt = 1

  this.uploaded = 0
  this.downloaded = 0
  this.uploadSpeed = speedometer()
  this.downloadSpeed = speedometer()

  this._keepAliveInterval = null
  this._timeout = null
  this._timeoutMs = 0

  this.destroyed = false // was the wire ended by calling `destroy`?
  this._finished = false

  this._parserSize = 0 // number of needed bytes to parse next message from remote peer
  this._parser = null // function to call once `this._parserSize` bytes are available

  this._buffer = [] // incomplete message data
  this._bufferSize = 0 // cached total length of buffers in `this._buffer`

  this.on('finish', this._onFinish)

  this._parseHandshake()
}

/**
 * Set whether to send a "keep-alive" ping (sent every 55s)
 * @param {boolean} enable
 */
Wire.prototype.setKeepAlive = function (enable) {
  var self = this
  self._debug('setKeepAlive %s', enable)
  clearInterval(self._keepAliveInterval)
  if (enable === false) return
  self._keepAliveInterval = setInterval(function () {
    self.keepAlive()
  }, KEEP_ALIVE_TIMEOUT)
}

/**
 * Set the amount of time to wait before considering a request to be "timed out"
 * @param {number} ms
 * @param {boolean=} unref (should the timer be unref'd? default: false)
 */
Wire.prototype.setTimeout = function (ms, unref) {
  this._debug('setTimeout ms=%d unref=%s', ms, unref)
  this._clearTimeout()
  this._timeoutMs = ms
  this._timeoutUnref = !!unref
  this._updateTimeout()
}

Wire.prototype.destroy = function () {
  if (this.destroyed) return
  this.destroyed = true
  this._debug('destroy')
  this.emit('close')
  this.end()
}

Wire.prototype.end = function () {
  this._debug('end')
  this._onUninterested()
  this._onChoke()
  stream.Duplex.prototype.end.apply(this, arguments)
}

/**
 * Use the specified protocol extension.
 * @param  {function} Extension
 */
Wire.prototype.use = function (Extension) {
  var name = Extension.prototype.name
  if (!name) {
    throw new Error('Extension class requires a "name" property on the prototype')
  }
  this._debug('use extension.name=%s', name)

  var ext = this._nextExt
  var handler = new Extension(this)

  function noop () {}

  if (typeof handler.onHandshake !== 'function') {
    handler.onHandshake = noop
  }
  if (typeof handler.onExtendedHandshake !== 'function') {
    handler.onExtendedHandshake = noop
  }
  if (typeof handler.onMessage !== 'function') {
    handler.onMessage = noop
  }

  this.extendedMapping[ext] = name
  this._ext[name] = handler
  this[name] = handler

  this._nextExt += 1
}

//
// OUTGOING MESSAGES
//

/**
 * Message "keep-alive": <len=0000>
 */
Wire.prototype.keepAlive = function () {
  this._debug('keep-alive')
  this._push(MESSAGE_KEEP_ALIVE)
}

/**
 * Message: "handshake" <pstrlen><pstr><reserved><info_hash><peer_id>
 * @param  {Buffer|string} infoHash (as Buffer or *hex* string)
 * @param  {Buffer|string} peerId
 * @param  {Object} extensions
 */
Wire.prototype.handshake = function (infoHash, peerId, extensions) {
  var infoHashBuffer, peerIdBuffer
  if (typeof infoHash === 'string') {
    infoHashBuffer = new Buffer(infoHash, 'hex')
  } else {
    infoHashBuffer = infoHash
    infoHash = infoHashBuffer.toString('hex')
  }
  if (typeof peerId === 'string') {
    peerIdBuffer = new Buffer(peerId, 'hex')
  } else {
    peerIdBuffer = peerId
    peerId = peerIdBuffer.toString('hex')
  }

  if (infoHashBuffer.length !== 20 || peerIdBuffer.length !== 20) {
    throw new Error('infoHash and peerId MUST have length 20')
  }

  this._debug('handshake i=%s p=%s exts=%o', infoHash, peerId, extensions)

  var reserved = new Buffer(MESSAGE_RESERVED)

  // enable extended message
  reserved[5] |= 0x10

  if (extensions && extensions.dht) reserved[7] |= 1

  this._push(Buffer.concat([MESSAGE_PROTOCOL, reserved, infoHashBuffer, peerIdBuffer]))
  this._handshakeSent = true

  if (this.peerExtensions.extended && !this._extendedHandshakeSent) {
    // Peer's handshake indicated support already
    // (incoming connection)
    this._sendExtendedHandshake()
  }
}

/* Peer supports BEP-0010, send extended handshake.
 *
 * This comes after the 'handshake' event to give the user a chance to populate
 * `this.extendedHandshake` and `this.extendedMapping` before the extended handshake
 * is sent to the remote peer.
 */
Wire.prototype._sendExtendedHandshake = function () {
  // Create extended message object from registered extensions
  var msg = extend(this.extendedHandshake)
  msg.m = {}
  for (var ext in this.extendedMapping) {
    var name = this.extendedMapping[ext]
    msg.m[name] = Number(ext)
  }

  // Send extended handshake
  this.extended(0, bencode.encode(msg))
  this._extendedHandshakeSent = true
}

/**
 * Message "choke": <len=0001><id=0>
 */
Wire.prototype.choke = function () {
  if (this.amChoking) return
  this.amChoking = true
  this._debug('choke')
  this.peerRequests.splice(0, this.peerRequests.length)
  this._push(MESSAGE_CHOKE)
}

/**
 * Message "unchoke": <len=0001><id=1>
 */
Wire.prototype.unchoke = function () {
  if (!this.amChoking) return
  this.amChoking = false
  this._debug('unchoke')
  this._push(MESSAGE_UNCHOKE)
}

/**
 * Message "interested": <len=0001><id=2>
 */
Wire.prototype.interested = function () {
  if (this.amInterested) return
  this.amInterested = true
  this._debug('interested')
  this._push(MESSAGE_INTERESTED)
}

/**
 * Message "uninterested": <len=0001><id=3>
 */
Wire.prototype.uninterested = function () {
  if (!this.amInterested) return
  this.amInterested = false
  this._debug('uninterested')
  this._push(MESSAGE_UNINTERESTED)
}

/**
 * Message "have": <len=0005><id=4><piece index>
 * @param  {number} index
 */
Wire.prototype.have = function (index) {
  this._debug('have %d', index)
  this._message(4, [index], null)
}

/**
 * Message "bitfield": <len=0001+X><id=5><bitfield>
 * @param  {BitField|Buffer} bitfield
 */
Wire.prototype.bitfield = function (bitfield) {
  this._debug('bitfield')
  if (!Buffer.isBuffer(bitfield)) bitfield = bitfield.buffer
  this._message(5, [], bitfield)
}

/**
 * Message "request": <len=0013><id=6><index><begin><length>
 * @param  {number}   index
 * @param  {number}   offset
 * @param  {number}   length
 * @param  {function} cb
 */
Wire.prototype.request = function (index, offset, length, cb) {
  if (!cb) cb = function () {}
  if (this._finished) return cb(new Error('wire is closed'))
  if (this.peerChoking) return cb(new Error('peer is choking'))

  this._debug('request index=%d offset=%d length=%d', index, offset, length)

  this.requests.push(new Request(index, offset, length, cb))
  this._updateTimeout()
  this._message(6, [index, offset, length], null)
}

/**
 * Message "piece": <len=0009+X><id=7><index><begin><block>
 * @param  {number} index
 * @param  {number} offset
 * @param  {Buffer} buffer
 */
Wire.prototype.piece = function (index, offset, buffer) {
  this._debug('piece index=%d offset=%d', index, offset)
  this.uploaded += buffer.length
  this.uploadSpeed(buffer.length)
  this.emit('upload', buffer.length)
  this._message(7, [index, offset], buffer)
}

/**
 * Message "cancel": <len=0013><id=8><index><begin><length>
 * @param  {number} index
 * @param  {number} offset
 * @param  {number} length
 */
Wire.prototype.cancel = function (index, offset, length) {
  this._debug('cancel index=%d offset=%d length=%d', index, offset, length)
  this._callback(
    pull(this.requests, index, offset, length),
    new Error('request was cancelled'),
    null
  )
  this._message(8, [index, offset, length], null)
}

/**
 * Message: "port" <len=0003><id=9><listen-port>
 * @param {Number} port
 */
Wire.prototype.port = function (port) {
  this._debug('port %d', port)
  var message = new Buffer(MESSAGE_PORT)
  message.writeUInt16BE(port, 5)
  this._push(message)
}

/**
 * Message: "extended" <len=0005+X><id=20><ext-number><payload>
 * @param  {number|string} ext
 * @param  {Object} obj
 */
Wire.prototype.extended = function (ext, obj) {
  this._debug('extended ext=%s', ext)
  if (typeof ext === 'string' && this.peerExtendedMapping[ext]) {
    ext = this.peerExtendedMapping[ext]
  }
  if (typeof ext === 'number') {
    var ext_id = new Buffer([ext])
    var buf = Buffer.isBuffer(obj) ? obj : bencode.encode(obj)

    this._message(20, [], Buffer.concat([ext_id, buf]))
  } else {
    throw new Error('Unrecognized extension: ' + ext)
  }
}

/**
 * Duplex stream method. Called whenever the remote peer stream wants data. No-op
 * since we'll just push data whenever we get it.
 */
Wire.prototype._read = function () {}

/**
 * Send a message to the remote peer.
 */
Wire.prototype._message = function (id, numbers, data) {
  var dataLength = data ? data.length : 0
  var buffer = new Buffer(5 + 4 * numbers.length)

  buffer.writeUInt32BE(buffer.length + dataLength - 4, 0)
  buffer[4] = id
  for (var i = 0; i < numbers.length; i++) {
    buffer.writeUInt32BE(numbers[i], 5 + 4 * i)
  }

  this._push(buffer)
  if (data) this._push(data)
}

Wire.prototype._push = function (data) {
  if (this._finished) return
  return this.push(data)
}

//
// INCOMING MESSAGES
//

Wire.prototype._onKeepAlive = function () {
  this._debug('got keep-alive')
  this.emit('keep-alive')
}

Wire.prototype._onHandshake = function (infoHashBuffer, peerIdBuffer, extensions) {
  var infoHash = infoHashBuffer.toString('hex')
  var peerId = peerIdBuffer.toString('hex')

  this._debug('got handshake i=%s p=%s exts=%o', infoHash, peerId, extensions)

  this.peerId = peerId
  this.peerIdBuffer = peerIdBuffer
  this.peerExtensions = extensions

  this.emit('handshake', infoHash, peerId, extensions)

  var name
  for (name in this._ext) {
    this._ext[name].onHandshake(infoHash, peerId, extensions)
  }

  if (extensions.extended && this._handshakeSent &&
      !this._extendedHandshakeSent) {
    // outgoing connection
    this._sendExtendedHandshake()
  }
}

Wire.prototype._onChoke = function () {
  this.peerChoking = true
  this._debug('got choke')
  this.emit('choke')
  while (this.requests.length) {
    this._callback(this.requests.shift(), new Error('peer is choking'), null)
  }
}

Wire.prototype._onUnchoke = function () {
  this.peerChoking = false
  this._debug('got unchoke')
  this.emit('unchoke')
}

Wire.prototype._onInterested = function () {
  this.peerInterested = true
  this._debug('got interested')
  this.emit('interested')
}

Wire.prototype._onUninterested = function () {
  this.peerInterested = false
  this._debug('got uninterested')
  this.emit('uninterested')
}

Wire.prototype._onHave = function (index) {
  if (this.peerPieces.get(index)) return
  this._debug('got have %d', index)

  this.peerPieces.set(index, true)
  this.emit('have', index)
}

Wire.prototype._onBitField = function (buffer) {
  this.peerPieces = new BitField(buffer)
  this._debug('got bitfield')
  this.emit('bitfield', this.peerPieces)
}

Wire.prototype._onRequest = function (index, offset, length) {
  var self = this
  if (self.amChoking) return
  self._debug('got request index=%d offset=%d length=%d', index, offset, length)

  var respond = function (err, buffer) {
    if (request !== pull(self.peerRequests, index, offset, length)) return
    if (err) return self._debug('error satisfying request index=%d offset=%d length=%d (%s)', index, offset, length, err.message)
    self.piece(index, offset, buffer)
  }

  var request = new Request(index, offset, length, respond)
  self.peerRequests.push(request)
  self.emit('request', index, offset, length, respond)
}

Wire.prototype._onPiece = function (index, offset, buffer) {
  this._debug('got piece index=%d offset=%d', index, offset)
  this._callback(pull(this.requests, index, offset, buffer.length), null, buffer)
  this.downloaded += buffer.length
  this.downloadSpeed(buffer.length)
  this.emit('download', buffer.length)
  this.emit('piece', index, offset, buffer)
}

Wire.prototype._onCancel = function (index, offset, length) {
  this._debug('got cancel index=%d offset=%d length=%d', index, offset, length)
  pull(this.peerRequests, index, offset, length)
  this.emit('cancel', index, offset, length)
}

Wire.prototype._onPort = function (port) {
  this._debug('got port %d', port)
  this.emit('port', port)
}

Wire.prototype._onExtended = function (ext, buf) {
  if (ext === 0) {
    var info
    try {
      info = bencode.decode(buf)
    } catch (err) {
      this._debug('ignoring invalid extended handshake: %s', err.message || err)
    }

    if (!info) return
    this.peerExtendedHandshake = info

    var name
    if (typeof info.m === 'object') {
      for (name in info.m) {
        this.peerExtendedMapping[name] = Number(info.m[name].toString())
      }
    }
    for (name in this._ext) {
      if (this.peerExtendedMapping[name]) {
        this._ext[name].onExtendedHandshake(this.peerExtendedHandshake)
      }
    }
    this._debug('got extended handshake')
    this.emit('extended', 'handshake', this.peerExtendedHandshake)
  } else {
    if (this.extendedMapping[ext]) {
      ext = this.extendedMapping[ext] // friendly name for extension
      if (this._ext[ext]) {
        // there is an registered extension handler, so call it
        this._ext[ext].onMessage(buf)
      }
    }
    this._debug('got extended message ext=%s', ext)
    this.emit('extended', ext, buf)
  }
}

Wire.prototype._onTimeout = function () {
  this._debug('request timed out')
  this._callback(this.requests.shift(), new Error('request has timed out'), null)
  this.emit('timeout')
}

/**
 * Duplex stream method. Called whenever the remote peer has data for us. Data that the
 * remote peer sends gets buffered (i.e. not actually processed) until the right number
 * of bytes have arrived, determined by the last call to `this._parse(number, callback)`.
 * Once enough bytes have arrived to process the message, the callback function
 * (i.e. `this._parser`) gets called with the full buffer of data.
 * @param  {Buffer} data
 * @param  {string} encoding
 * @param  {function} cb
 */
Wire.prototype._write = function (data, encoding, cb) {
  this._bufferSize += data.length
  this._buffer.push(data)

  while (this._bufferSize >= this._parserSize) {
    var buffer = (this._buffer.length === 1)
      ? this._buffer[0]
      : Buffer.concat(this._buffer)
    this._bufferSize -= this._parserSize
    this._buffer = this._bufferSize
      ? [buffer.slice(this._parserSize)]
      : []
    this._parser(buffer.slice(0, this._parserSize))
  }

  cb(null) // Signal that we're ready for more data
}

Wire.prototype._callback = function (request, err, buffer) {
  if (!request) return

  this._clearTimeout()

  if (!this.peerChoking && !this._finished) this._updateTimeout()
  request.callback(err, buffer)
}

Wire.prototype._clearTimeout = function () {
  if (!this._timeout) return

  clearTimeout(this._timeout)
  this._timeout = null
}

Wire.prototype._updateTimeout = function () {
  var self = this
  if (!self._timeoutMs || !self.requests.length || self._timeout) return

  self._timeout = setTimeout(function () {
    self._onTimeout()
  }, self._timeoutMs)
  if (self._timeoutUnref && self._timeout.unref) self._timeout.unref()
}

/**
 * Takes a number of bytes that the local peer is waiting to receive from the remote peer
 * in order to parse a complete message, and a callback function to be called once enough
 * bytes have arrived.
 * @param  {number} size
 * @param  {function} parser
 */
Wire.prototype._parse = function (size, parser) {
  this._parserSize = size
  this._parser = parser
}

/**
 * Handle the first 4 bytes of a message, to determine the length of bytes that must be
 * waited for in order to have the whole message.
 * @param  {Buffer} buffer
 */
Wire.prototype._onMessageLength = function (buffer) {
  var length = buffer.readUInt32BE(0)
  if (length > 0) {
    this._parse(length, this._onMessage)
  } else {
    this._onKeepAlive()
    this._parse(4, this._onMessageLength)
  }
}

/**
 * Handle a message from the remote peer.
 * @param  {Buffer} buffer
 */
Wire.prototype._onMessage = function (buffer) {
  this._parse(4, this._onMessageLength)
  switch (buffer[0]) {
    case 0:
      return this._onChoke()
    case 1:
      return this._onUnchoke()
    case 2:
      return this._onInterested()
    case 3:
      return this._onUninterested()
    case 4:
      return this._onHave(buffer.readUInt32BE(1))
    case 5:
      return this._onBitField(buffer.slice(1))
    case 6:
      return this._onRequest(buffer.readUInt32BE(1),
          buffer.readUInt32BE(5), buffer.readUInt32BE(9))
    case 7:
      return this._onPiece(buffer.readUInt32BE(1),
          buffer.readUInt32BE(5), buffer.slice(9))
    case 8:
      return this._onCancel(buffer.readUInt32BE(1),
          buffer.readUInt32BE(5), buffer.readUInt32BE(9))
    case 9:
      return this._onPort(buffer.readUInt16BE(1))
    case 20:
      return this._onExtended(buffer.readUInt8(1), buffer.slice(2))
    default:
      this._debug('got unknown message')
      return this.emit('unknownmessage', buffer)
  }
}

Wire.prototype._parseHandshake = function () {
  var self = this
  self._parse(1, function (buffer) {
    var pstrlen = buffer.readUInt8(0)
    self._parse(pstrlen + 48, function (handshake) {
      var protocol = handshake.slice(0, pstrlen)
      if (protocol.toString() !== 'BitTorrent protocol') {
        self._debug('Error: wire not speaking BitTorrent protocol (%s)', protocol.toString())
        self.end()
        return
      }
      handshake = handshake.slice(pstrlen)
      self._onHandshake(handshake.slice(8, 28), handshake.slice(28, 48), {
        dht: !!(handshake[7] & 0x01), // see bep_0005
        extended: !!(handshake[5] & 0x10) // see bep_0010
      })
      self._parse(4, self._onMessageLength)
    })
  })
}

Wire.prototype._onFinish = function () {
  this._finished = true

  this.push(null) // stream cannot be half open, so signal the end of it
  while (this.read()) {} // consume and discard the rest of the stream data

  clearInterval(this._keepAliveInterval)
  this._parse(Number.MAX_VALUE, function () {})
  this.peerRequests = []
  while (this.requests.length) {
    this._callback(this.requests.shift(), new Error('wire was closed'), null)
  }
}

Wire.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args[0] = '[' + this._debugId + '] ' + args[0]
  debug.apply(null, args)
}

function pull (requests, piece, offset, length) {
  for (var i = 0; i < requests.length; i++) {
    var req = requests[i]
    if (req.piece !== piece || req.offset !== offset || req.length !== length) continue

    if (i === 0) requests.shift()
    else requests.splice(i, 1)

    return req
  }
  return null
}

}).call(this,require("buffer").Buffer)
},{"bencode":12,"bitfield":10,"buffer":25,"debug":93,"hat":99,"inherits":101,"readable-stream":133,"speedometer":149,"xtend":172}],12:[function(require,module,exports){
var bencode = module.exports

bencode.encode = require( './lib/encode' )
bencode.decode = require( './lib/decode' )

/**
 * Determines the amount of bytes
 * needed to encode the given value
 * @param  {Object|Array|Buffer|String|Number|Boolean} value
 * @return {Number} byteCount
 */
bencode.byteLength = bencode.encodingLength = function( value ) {
  return bencode.encode( value ).length
}

},{"./lib/decode":13,"./lib/encode":15}],13:[function(require,module,exports){
(function (Buffer){
var Dict = require("./dict")

/**
 * Decodes bencoded data.
 *
 * @param  {Buffer} data
 * @param  {Number} start (optional)
 * @param  {Number} end (optional)
 * @param  {String} encoding (optional)
 * @return {Object|Array|Buffer|String|Number}
 */
function decode( data, start, end, encoding ) {
  
  if( typeof start !== 'number' && encoding == null ) {
    encoding = start
    start = undefined
  }
  
  if( typeof end !== 'number' && encoding == null ) {
    encoding = end
    end = undefined
  }
  
  decode.position = 0
  decode.encoding = encoding || null

  decode.data = !( Buffer.isBuffer(data) )
    ? new Buffer( data )
    : data.slice( start, end )
  
  decode.bytes = decode.data.length
  
  return decode.next()

}

decode.bytes = 0
decode.position = 0
decode.data     = null
decode.encoding = null

decode.next = function() {

  switch( decode.data[decode.position] ) {
    case 0x64: return decode.dictionary(); break
    case 0x6C: return decode.list(); break
    case 0x69: return decode.integer(); break
    default:   return decode.buffer(); break
  }

}

decode.find = function( chr ) {

  var i = decode.position
  var c = decode.data.length
  var d = decode.data

  while( i < c ) {
    if( d[i] === chr )
      return i
    i++
  }

  throw new Error(
    'Invalid data: Missing delimiter "' +
    String.fromCharCode( chr ) + '" [0x' +
    chr.toString( 16 ) + ']'
  )

}

decode.dictionary = function() {

  decode.position++

  var dict = new Dict()

  while( decode.data[decode.position] !== 0x65 ) {
    dict.binarySet(decode.buffer(), decode.next())
  }

  decode.position++

  return dict

}

decode.list = function() {

  decode.position++

  var lst = []

  while( decode.data[decode.position] !== 0x65 ) {
    lst.push( decode.next() )
  }

  decode.position++

  return lst

}

decode.integer = function() {

  var end    = decode.find( 0x65 )
  var number = decode.data.toString( 'ascii', decode.position + 1, end )

  decode.position += end + 1 - decode.position

  return parseInt( number, 10 )

}

decode.buffer = function() {

  var sep    = decode.find( 0x3A )
  var length = parseInt( decode.data.toString( 'ascii', decode.position, sep ), 10 )
  var end    = ++sep + length

  decode.position = end

  return decode.encoding
    ? decode.data.toString( decode.encoding, sep, end )
    : decode.data.slice( sep, end )

}

// Exports
module.exports = decode

}).call(this,require("buffer").Buffer)
},{"./dict":14,"buffer":25}],14:[function(require,module,exports){
var Dict = module.exports = function Dict() {
  Object.defineProperty(this, "_keys", {
    enumerable: false,
    value: [],
  })
}

Dict.prototype.binaryKeys = function binaryKeys() {
  return this._keys.slice()
}

Dict.prototype.binarySet = function binarySet(key, value) {
  this._keys.push(key)

  this[key] = value
}

},{}],15:[function(require,module,exports){
(function (Buffer){
/**
 * Encodes data in bencode.
 *
 * @param  {Buffer|Array|String|Object|Number|Boolean} data
 * @return {Buffer}
 */
function encode( data, buffer, offset ) {
  
  var buffers = []
  var result = null
  
  encode._encode( buffers, data )
  result = Buffer.concat( buffers )
  encode.bytes = result.length
  
  if( Buffer.isBuffer( buffer ) ) {
    result.copy( buffer, offset )
    return buffer
  }
  
  return result
  
}

encode.bytes = -1
encode._floatConversionDetected = false

encode._encode = function( buffers, data ) {

  if( Buffer.isBuffer(data) ) {
    buffers.push(new Buffer(data.length + ':'))
    buffers.push(data)
    return;
  }

  switch( typeof data ) {
    case 'string':
      encode.buffer( buffers, data )
      break
    case 'number':
      encode.number( buffers, data )
      break
    case 'object':
      data.constructor === Array
        ? encode.list( buffers, data )
        : encode.dict( buffers, data )
      break
    case 'boolean':
      encode.number( buffers, data ? 1 : 0 )
      break
  }

}

var buff_e = new Buffer('e')
  , buff_d = new Buffer('d')
  , buff_l = new Buffer('l')

encode.buffer = function( buffers, data ) {

  buffers.push( new Buffer(Buffer.byteLength( data ) + ':' + data) )
}

encode.number = function( buffers, data ) {
  var maxLo = 0x80000000
  var hi = ( data / maxLo ) << 0
  var lo = ( data % maxLo  ) << 0
  var val = hi * maxLo + lo

  buffers.push( new Buffer( 'i' + val + 'e' ))

  if( val !== data && !encode._floatConversionDetected ) {
    encode._floatConversionDetected = true
    console.warn(
      'WARNING: Possible data corruption detected with value "'+data+'":',
      'Bencoding only defines support for integers, value was converted to "'+val+'"'
    )
    console.trace()
  }

}

encode.dict = function( buffers, data ) {

  buffers.push( buff_d )

  var j = 0
  var k
  // fix for issue #13 - sorted dicts
  var keys = Object.keys( data ).sort()
  var kl = keys.length

  for( ; j < kl ; j++) {
    k=keys[j]
    encode.buffer( buffers, k )
    encode._encode( buffers, data[k] )
  }

  buffers.push( buff_e )
}

encode.list = function( buffers, data ) {

  var i = 0, j = 1
  var c = data.length
  buffers.push( buff_l )

  for( ; i < c; i++ ) {
    encode._encode( buffers, data[i] )
  }

  buffers.push( buff_e )

}

// Expose
module.exports = encode

}).call(this,require("buffer").Buffer)
},{"buffer":25}],16:[function(require,module,exports){
(function (process,Buffer){
module.exports = Client

var debug = require('debug')('bittorrent-tracker')
var EventEmitter = require('events').EventEmitter
var extend = require('xtend')
var inherits = require('inherits')
var once = require('once')
var parallel = require('run-parallel')
var uniq = require('uniq')
var url = require('url')

var common = require('./lib/common')
var HTTPTracker = require('./lib/client/http-tracker') // empty object in browser
var UDPTracker = require('./lib/client/udp-tracker') // empty object in browser
var WebSocketTracker = require('./lib/client/websocket-tracker')

inherits(Client, EventEmitter)

/**
 * BitTorrent tracker client.
 *
 * Find torrent peers, to help a torrent client participate in a torrent swarm.
 *
 * @param {Object} opts                          options object
 * @param {string|Buffer} opts.infoHash          torrent info hash
 * @param {string|Buffer} opts.peerId            peer id
 * @param {string|Array.<string>} opts.announce  announce
 * @param {number} opts.port                     torrent client listening port
 * @param {function} opts.getAnnounceOpts        callback to provide data to tracker
 * @param {number} opts.rtcConfig                RTCPeerConnection configuration object
 * @param {number} opts.wrtc                     custom webrtc impl (useful in node.js)
 */
function Client (opts) {
  var self = this
  if (!(self instanceof Client)) return new Client(opts)
  EventEmitter.call(self)
  if (!opts) opts = {}

  if (!opts.peerId) throw new Error('Option `peerId` is required')
  if (!opts.infoHash) throw new Error('Option `infoHash` is required')
  if (!opts.announce) throw new Error('Option `announce` is required')
  if (!process.browser && !opts.port) throw new Error('Option `port` is required')

  // required
  self.peerId = typeof opts.peerId === 'string'
    ? opts.peerId
    : opts.peerId.toString('hex')
  self._peerIdBuffer = new Buffer(self.peerId, 'hex')
  self._peerIdBinary = self._peerIdBuffer.toString('binary')

  self.infoHash = typeof opts.infoHash === 'string'
    ? opts.infoHash
    : opts.infoHash.toString('hex')
  self._infoHashBuffer = new Buffer(self.infoHash, 'hex')
  self._infoHashBinary = self._infoHashBuffer.toString('binary')

  self._port = opts.port

  self.destroyed = false

  self._rtcConfig = opts.rtcConfig
  self._wrtc = opts.wrtc
  self._getAnnounceOpts = opts.getAnnounceOpts

  debug('new client %s', self.infoHash)

  var webrtcSupport = !!self._wrtc || typeof window !== 'undefined'

  var announce = (typeof opts.announce === 'string')
    ? [ opts.announce ]
    : opts.announce == null
      ? []
      : opts.announce

  announce = announce.map(function (announceUrl) {
    announceUrl = announceUrl.toString()
    if (announceUrl[announceUrl.length - 1] === '/') {
      // remove trailing slash from trackers to catch duplicates
      announceUrl = announceUrl.substring(0, announceUrl.length - 1)
    }
    return announceUrl
  })

  announce = uniq(announce)

  self._trackers = announce
    .map(function (announceUrl) {
      var protocol = url.parse(announceUrl).protocol
      if ((protocol === 'http:' || protocol === 'https:') &&
          typeof HTTPTracker === 'function') {
        return new HTTPTracker(self, announceUrl)
      } else if (protocol === 'udp:' && typeof UDPTracker === 'function') {
        return new UDPTracker(self, announceUrl)
      } else if ((protocol === 'ws:' || protocol === 'wss:') && webrtcSupport) {
        // Skip ws:// trackers on https:// sites because they throw SecurityError
        if (protocol === 'ws:' && typeof window !== 'undefined' &&
            window.location.protocol === 'https:') {
          nextTickWarn(new Error('Unsupported tracker protocol: ' + announceUrl))
          return null
        }
        return new WebSocketTracker(self, announceUrl)
      } else {
        nextTickWarn(new Error('Unsupported tracker protocol: ' + announceUrl))
        return null
      }
    })
    .filter(Boolean)

  function nextTickWarn (err) {
    process.nextTick(function () {
      self.emit('warning', err)
    })
  }
}

/**
 * Simple convenience function to scrape a tracker for an info hash without needing to
 * create a Client, pass it a parsed torrent, etc. Support scraping a tracker for multiple
 * torrents at the same time.
 * @params {Object} opts
 * @param  {string|Array.<string>} opts.infoHash
 * @param  {string} opts.announce
 * @param  {function} cb
 */
Client.scrape = function (opts, cb) {
  cb = once(cb)

  if (!opts.infoHash) throw new Error('Option `infoHash` is required')
  if (!opts.announce) throw new Error('Option `announce` is required')

  var clientOpts = extend(opts, {
    infoHash: Array.isArray(opts.infoHash) ? opts.infoHash[0] : opts.infoHash,
    peerId: new Buffer('01234567890123456789'), // dummy value
    port: 6881 // dummy value
  })

  var client = new Client(clientOpts)
  client.once('error', cb)

  var len = Array.isArray(opts.infoHash) ? opts.infoHash.length : 1
  var results = {}
  client.on('scrape', function (data) {
    len -= 1
    results[data.infoHash] = data
    if (len === 0) {
      client.destroy()
      var keys = Object.keys(results)
      if (keys.length === 1) {
        cb(null, results[keys[0]])
      } else {
        cb(null, results)
      }
    }
  })

  opts.infoHash = Array.isArray(opts.infoHash)
    ? opts.infoHash.map(function (infoHash) { return new Buffer(infoHash, 'hex') })
    : new Buffer(opts.infoHash, 'hex')
  client.scrape({ infoHash: opts.infoHash })
  return client
}

/**
 * Send a `start` announce to the trackers.
 * @param {Object} opts
 * @param {number=} opts.uploaded
 * @param {number=} opts.downloaded
 * @param {number=} opts.left (if not set, calculated automatically)
 */
Client.prototype.start = function (opts) {
  var self = this
  debug('send `start`')
  opts = self._defaultAnnounceOpts(opts)
  opts.event = 'started'
  self._announce(opts)

  // start announcing on intervals
  self._trackers.forEach(function (tracker) {
    tracker.setInterval()
  })
}

/**
 * Send a `stop` announce to the trackers.
 * @param {Object} opts
 * @param {number=} opts.uploaded
 * @param {number=} opts.downloaded
 * @param {number=} opts.numwant
 * @param {number=} opts.left (if not set, calculated automatically)
 */
Client.prototype.stop = function (opts) {
  var self = this
  debug('send `stop`')
  opts = self._defaultAnnounceOpts(opts)
  opts.event = 'stopped'
  self._announce(opts)
}

/**
 * Send a `complete` announce to the trackers.
 * @param {Object} opts
 * @param {number=} opts.uploaded
 * @param {number=} opts.downloaded
 * @param {number=} opts.numwant
 * @param {number=} opts.left (if not set, calculated automatically)
 */
Client.prototype.complete = function (opts) {
  var self = this
  debug('send `complete`')
  if (!opts) opts = {}
  opts = self._defaultAnnounceOpts(opts)
  opts.event = 'completed'
  self._announce(opts)
}

/**
 * Send a `update` announce to the trackers.
 * @param {Object} opts
 * @param {number=} opts.uploaded
 * @param {number=} opts.downloaded
 * @param {number=} opts.numwant
 * @param {number=} opts.left (if not set, calculated automatically)
 */
Client.prototype.update = function (opts) {
  var self = this
  debug('send `update`')
  opts = self._defaultAnnounceOpts(opts)
  if (opts.event) delete opts.event
  self._announce(opts)
}

Client.prototype._announce = function (opts) {
  var self = this
  self._trackers.forEach(function (tracker) {
    // tracker should not modify `opts` object, it's passed to all trackers
    tracker.announce(opts)
  })
}

/**
 * Send a scrape request to the trackers.
 * @param {Object} opts
 */
Client.prototype.scrape = function (opts) {
  var self = this
  debug('send `scrape`')
  if (!opts) opts = {}
  self._trackers.forEach(function (tracker) {
    // tracker should not modify `opts` object, it's passed to all trackers
    tracker.scrape(opts)
  })
}

Client.prototype.setInterval = function (intervalMs) {
  var self = this
  debug('setInterval %d', intervalMs)
  self._trackers.forEach(function (tracker) {
    tracker.setInterval(intervalMs)
  })
}

Client.prototype.destroy = function (cb) {
  var self = this
  if (self.destroyed) return
  self.destroyed = true
  debug('destroy')

  var tasks = self._trackers.map(function (tracker) {
    return function (cb) {
      tracker.destroy(cb)
    }
  })

  parallel(tasks, cb)
  self._trackers = []
}

Client.prototype._defaultAnnounceOpts = function (opts) {
  var self = this
  if (!opts) opts = {}

  if (opts.numwant == null) opts.numwant = common.DEFAULT_ANNOUNCE_PEERS

  if (opts.uploaded == null) opts.uploaded = 0
  if (opts.downloaded == null) opts.downloaded = 0

  if (self._getAnnounceOpts) opts = extend(opts, self._getAnnounceOpts())
  return opts
}

}).call(this,require('_process'),require("buffer").Buffer)
},{"./lib/client/http-tracker":24,"./lib/client/udp-tracker":24,"./lib/client/websocket-tracker":18,"./lib/common":19,"_process":33,"buffer":25,"debug":93,"events":29,"inherits":101,"once":21,"run-parallel":139,"uniq":158,"url":45,"xtend":172}],17:[function(require,module,exports){
module.exports = Tracker

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')

inherits(Tracker, EventEmitter)

function Tracker (client, announceUrl) {
  var self = this
  EventEmitter.call(self)
  self.client = client
  self.announceUrl = announceUrl

  self.interval = null
  self.destroyed = false
}

Tracker.prototype.setInterval = function (intervalMs) {
  var self = this
  if (intervalMs == null) intervalMs = self.DEFAULT_ANNOUNCE_INTERVAL

  clearInterval(self.interval)

  if (intervalMs) {
    self.interval = setInterval(function () {
      self.announce(self.client._defaultAnnounceOpts())
    }, intervalMs)
    if (self.interval.unref) self.interval.unref()
  }
}

},{"events":29,"inherits":101}],18:[function(require,module,exports){
module.exports = WebSocketTracker

var debug = require('debug')('bittorrent-tracker:websocket-tracker')
var extend = require('xtend')
var hat = require('hat')
var inherits = require('inherits')
var Peer = require('simple-peer')
var Socket = require('simple-websocket')

var common = require('../common')
var Tracker = require('./tracker')

// Use a socket pool, so tracker clients share WebSocket objects for the same server.
// In practice, WebSockets are pretty slow to establish, so this gives a nice performance
// boost, and saves browser resources.
var socketPool = {}

var RECONNECT_MINIMUM = 15 * 1000
var RECONNECT_MAXIMUM = 30 * 60 * 1000
var RECONNECT_VARIANCE = 30 * 1000
var OFFER_TIMEOUT = 50 * 1000

inherits(WebSocketTracker, Tracker)

function WebSocketTracker (client, announceUrl, opts) {
  var self = this
  Tracker.call(self, client, announceUrl)
  debug('new websocket tracker %s', announceUrl)

  self.peers = {} // peers (offer id -> peer)
  self.socket = null

  self.reconnecting = false
  self.retries = 0
  self.reconnectTimer = null

  self._openSocket()
}

WebSocketTracker.prototype.DEFAULT_ANNOUNCE_INTERVAL = 30 * 1000 // 30 seconds

WebSocketTracker.prototype.announce = function (opts) {
  var self = this
  if (self.destroyed || self.reconnecting) return
  if (!self.socket.connected) {
    self.socket.once('connect', function () {
      self.announce(opts)
    })
    return
  }

  var params = extend(opts, {
    action: 'announce',
    info_hash: self.client._infoHashBinary,
    peer_id: self.client._peerIdBinary
  })
  if (self._trackerId) params.trackerid = self._trackerId

  if (opts.event === 'stopped') {
    // Don't include offers with 'stopped' event
    self._send(params)
  } else {
    // Limit the number of offers that are generated, since it can be slow
    var numwant = Math.min(opts.numwant, 5)

    self._generateOffers(numwant, function (offers) {
      params.numwant = numwant
      params.offers = offers
      self._send(params)
    })
  }
}

WebSocketTracker.prototype.scrape = function (opts) {
  var self = this
  if (self.destroyed || self.reconnecting) return
  if (!self.socket.connected) {
    self.socket.once('connect', function () {
      self.scrape(opts)
    })
    return
  }

  var infoHashes = (Array.isArray(opts.infoHash) && opts.infoHash.length > 0)
    ? opts.infoHash.map(function (infoHash) {
      return infoHash.toString('binary')
    })
    : (opts.infoHash && opts.infoHash.toString('binary')) || self.client._infoHashBinary
  var params = {
    action: 'scrape',
    info_hash: infoHashes
  }

  self._send(params)
}

WebSocketTracker.prototype.destroy = function (cb) {
  var self = this
  if (!cb) cb = noop
  if (self.destroyed) return cb(null)

  self.destroyed = true

  clearInterval(self.interval)
  clearTimeout(self.reconnectTimer)

  if (self.socket) {
    self.socket.removeListener('connect', self._onSocketConnectBound)
    self.socket.removeListener('data', self._onSocketDataBound)
    self.socket.removeListener('close', self._onSocketCloseBound)
    self.socket.removeListener('error', self._onSocketErrorBound)
  }

  self._onSocketConnectBound = null
  self._onSocketErrorBound = null
  self._onSocketDataBound = null
  self._onSocketCloseBound = null

  // Destroy peers
  for (var peerId in self.peers) {
    var peer = self.peers[peerId]
    clearTimeout(peer.trackerTimeout)
    peer.destroy()
  }
  self.peers = null

  if (socketPool[self.announceUrl]) {
    socketPool[self.announceUrl].consumers -= 1
  }

  if (socketPool[self.announceUrl].consumers === 0) {
    delete socketPool[self.announceUrl]

    try {
      self.socket.on('error', noop) // ignore all future errors
      self.socket.destroy(cb)
    } catch (err) {
      cb(null)
    }
  } else {
    cb(null)
  }

  self.socket = null
}

WebSocketTracker.prototype._openSocket = function () {
  var self = this
  self.destroyed = false

  if (!self.peers) self.peers = {}

  self._onSocketConnectBound = function () {
    self._onSocketConnect()
  }
  self._onSocketErrorBound = function (err) {
    self._onSocketError(err)
  }
  self._onSocketDataBound = function (data) {
    self._onSocketData(data)
  }
  self._onSocketCloseBound = function () {
    self._onSocketClose()
  }

  self.socket = socketPool[self.announceUrl]
  if (self.socket) {
    socketPool[self.announceUrl].consumers += 1
  } else {
    self.socket = socketPool[self.announceUrl] = new Socket(self.announceUrl)
    self.socket.consumers = 1
    self.socket.on('connect', self._onSocketConnectBound)
  }

  self.socket.on('data', self._onSocketDataBound)
  self.socket.on('close', self._onSocketCloseBound)
  self.socket.on('error', self._onSocketErrorBound)
}

WebSocketTracker.prototype._onSocketConnect = function () {
  var self = this
  if (self.destroyed) return

  if (self.reconnecting) {
    self.reconnecting = false
    self.retries = 0
    self.announce(self.client._defaultAnnounceOpts())
  }
}

WebSocketTracker.prototype._onSocketData = function (data) {
  var self = this
  if (self.destroyed) return

  try {
    data = JSON.parse(data)
  } catch (err) {
    self.client.emit('warning', new Error('Invalid tracker response'))
    return
  }

  if (data.action === 'announce') {
    self._onAnnounceResponse(data)
  } else if (data.action === 'scrape') {
    self._onScrapeResponse(data)
  } else {
    self._onSocketError(new Error('invalid action in WS response: ' + data.action))
  }
}

WebSocketTracker.prototype._onAnnounceResponse = function (data) {
  var self = this

  if (data.info_hash !== self.client._infoHashBinary) {
    debug(
      'ignoring websocket data from %s for %s (looking for %s: reused socket)',
      self.announceUrl, common.binaryToHex(data.info_hash), self.client.infoHash
    )
    return
  }

  if (data.peer_id && data.peer_id === self.client._peerIdBinary) {
    // ignore offers/answers from this client
    return
  }

  debug(
    'received %s from %s for %s',
    JSON.stringify(data), self.announceUrl, self.client.infoHash
  )

  var failure = data['failure reason']
  if (failure) return self.client.emit('warning', new Error(failure))

  var warning = data['warning message']
  if (warning) self.client.emit('warning', new Error(warning))

  var interval = data.interval || data['min interval']
  if (interval) self.setInterval(interval * 1000)

  var trackerId = data['tracker id']
  if (trackerId) {
    // If absent, do not discard previous trackerId value
    self._trackerId = trackerId
  }

  if (data.complete != null) {
    self.client.emit('update', {
      announce: self.announceUrl,
      complete: data.complete,
      incomplete: data.incomplete
    })
  }

  var peer
  if (data.offer && data.peer_id) {
    debug('creating peer (from remote offer)')
    peer = new Peer({
      trickle: false,
      config: self.client._rtcConfig,
      wrtc: self.client._wrtc
    })
    peer.id = common.binaryToHex(data.peer_id)
    peer.once('signal', function (answer) {
      var params = {
        action: 'announce',
        info_hash: self.client._infoHashBinary,
        peer_id: self.client._peerIdBinary,
        to_peer_id: data.peer_id,
        answer: answer,
        offer_id: data.offer_id
      }
      if (self._trackerId) params.trackerid = self._trackerId
      self._send(params)
    })
    peer.signal(data.offer)
    self.client.emit('peer', peer)
  }

  if (data.answer && data.peer_id) {
    var offerId = common.binaryToHex(data.offer_id)
    peer = self.peers[offerId]
    if (peer) {
      peer.id = common.binaryToHex(data.peer_id)
      peer.signal(data.answer)
      self.client.emit('peer', peer)

      clearTimeout(peer.trackerTimeout)
      peer.trackerTimeout = null
      delete self.peers[offerId]
    } else {
      debug('got unexpected answer: ' + JSON.stringify(data.answer))
    }
  }
}

WebSocketTracker.prototype._onScrapeResponse = function (data) {
  var self = this
  data = data.files || {}

  var keys = Object.keys(data)
  if (keys.length === 0) {
    self.client.emit('warning', new Error('invalid scrape response'))
    return
  }

  keys.forEach(function (infoHash) {
    var response = data[infoHash]
    // TODO: optionally handle data.flags.min_request_interval
    // (separate from announce interval)
    self.client.emit('scrape', {
      announce: self.announceUrl,
      infoHash: common.binaryToHex(infoHash),
      complete: response.complete,
      incomplete: response.incomplete,
      downloaded: response.downloaded
    })
  })
}

WebSocketTracker.prototype._onSocketClose = function () {
  var self = this
  if (self.destroyed) return
  self.destroy()
  self._startReconnectTimer()
}

WebSocketTracker.prototype._onSocketError = function (err) {
  var self = this
  if (self.destroyed) return
  self.destroy()
  // errors will often happen if a tracker is offline, so don't treat it as fatal
  self.client.emit('warning', err)
  self._startReconnectTimer()
}

WebSocketTracker.prototype._startReconnectTimer = function () {
  var self = this
  var ms = Math.floor(Math.random() * RECONNECT_VARIANCE) + Math.min(Math.pow(2, self.retries) * RECONNECT_MINIMUM, RECONNECT_MAXIMUM)

  self.reconnecting = true
  clearTimeout(self.reconnectTimer)
  self.reconnectTimer = setTimeout(function () {
    self.retries++
    self._openSocket()
  }, ms)
  if (self.reconnectTimer.unref) self.reconnectTimer.unref()

  debug('reconnecting socket in %s ms', ms)
}

WebSocketTracker.prototype._send = function (params) {
  var self = this
  if (self.destroyed) return

  var message = JSON.stringify(params)
  debug('send %s', message)
  self.socket.send(message)
}

WebSocketTracker.prototype._generateOffers = function (numwant, cb) {
  var self = this
  var offers = []
  debug('generating %s offers', numwant)

  for (var i = 0; i < numwant; ++i) {
    generateOffer()
  }
  checkDone()

  function generateOffer () {
    var offerId = hat(160)
    debug('creating peer (from _generateOffers)')
    var peer = self.peers[offerId] = new Peer({
      initiator: true,
      trickle: false,
      config: self.client._rtcConfig,
      wrtc: self.client._wrtc
    })
    peer.once('signal', function (offer) {
      offers.push({
        offer: offer,
        offer_id: common.hexToBinary(offerId)
      })
      checkDone()
    })
    peer.trackerTimeout = setTimeout(function () {
      debug('tracker timeout: destroying peer')
      peer.trackerTimeout = null
      delete self.peers[offerId]
      peer.destroy()
    }, OFFER_TIMEOUT)
    if (peer.trackerTimeout.unref) peer.trackerTimeout.unref()
  }

  function checkDone () {
    if (offers.length === numwant) {
      debug('generated %s offers', numwant)
      cb(offers)
    }
  }
}

function noop () {}

},{"../common":19,"./tracker":17,"debug":93,"hat":99,"inherits":101,"simple-peer":143,"simple-websocket":22,"xtend":172}],19:[function(require,module,exports){
(function (Buffer){
/**
 * Functions/constants needed by both the client and server.
 */

var extend = require('xtend/mutable')

exports.DEFAULT_ANNOUNCE_PEERS = 50
exports.MAX_ANNOUNCE_PEERS = 82

exports.binaryToHex = function (str) {
  return new Buffer(str, 'binary').toString('hex')
}

exports.hexToBinary = function (str) {
  return new Buffer(str, 'hex').toString('binary')
}

var config = require('./common-node')
extend(exports, config)

}).call(this,require("buffer").Buffer)
},{"./common-node":24,"buffer":25,"xtend/mutable":173}],20:[function(require,module,exports){
// Returns a wrapper function that returns a wrapped callback
// The wrapper function should do some stuff, and return a
// presumably different callback function.
// This makes sure that own properties are retained, so that
// decorations and such are not lost along the way.
module.exports = wrappy
function wrappy (fn, cb) {
  if (fn && cb) return wrappy(fn)(cb)

  if (typeof fn !== 'function')
    throw new TypeError('need wrapper function')

  Object.keys(fn).forEach(function (k) {
    wrapper[k] = fn[k]
  })

  return wrapper

  function wrapper() {
    var args = new Array(arguments.length)
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i]
    }
    var ret = fn.apply(this, args)
    var cb = args[args.length-1]
    if (typeof ret === 'function' && ret !== cb) {
      Object.keys(cb).forEach(function (k) {
        ret[k] = cb[k]
      })
    }
    return ret
  }
}

},{}],21:[function(require,module,exports){
var wrappy = require('wrappy')
module.exports = wrappy(once)

once.proto = once(function () {
  Object.defineProperty(Function.prototype, 'once', {
    value: function () {
      return once(this)
    },
    configurable: true
  })
})

function once (fn) {
  var f = function () {
    if (f.called) return f.value
    f.called = true
    return f.value = fn.apply(this, arguments)
  }
  f.called = false
  return f
}

},{"wrappy":20}],22:[function(require,module,exports){
(function (process,Buffer){
module.exports = Socket

var debug = require('debug')('simple-websocket')
var inherits = require('inherits')
var stream = require('readable-stream')
var ws = require('ws') // websockets in node - will be empty object in browser

var WebSocket = typeof window !== 'undefined' ? window.WebSocket : ws

inherits(Socket, stream.Duplex)

/**
 * WebSocket. Same API as node core `net.Socket`. Duplex stream.
 * @param {string} url websocket server url
 * @param {Object} opts options to stream.Duplex
 */
function Socket (url, opts) {
  var self = this
  if (!(self instanceof Socket)) return new Socket(url, opts)
  if (!opts) opts = {}
  debug('new websocket: %s %o', url, opts)

  opts.allowHalfOpen = false
  if (opts.highWaterMark == null) opts.highWaterMark = 1024 * 1024

  stream.Duplex.call(self, opts)

  self.url = url
  self.connected = false
  self.destroyed = false

  self._maxBufferedAmount = opts.highWaterMark
  self._chunk = null
  self._cb = null
  self._interval = null

  try {
    self._ws = new WebSocket(self.url)
  } catch (err) {
    process.nextTick(function () {
      self._onError(err)
    })
    return
  }
  self._ws.binaryType = 'arraybuffer'
  self._ws.onopen = function () {
    self._onOpen()
  }
  self._ws.onmessage = function (event) {
    self._onMessage(event)
  }
  self._ws.onclose = function () {
    self._onClose()
  }
  self._ws.onerror = function () {
    self._onError(new Error('connection error to ' + self.url))
  }

  self.on('finish', function () {
    if (self.connected) {
      // When stream is finished writing, close socket connection. Half open connections
      // are currently not supported.
      // Wait a bit before destroying so the socket flushes.
      // TODO: is there a more reliable way to accomplish this?
      setTimeout(function () {
        self._destroy()
      }, 100)
    } else {
      // If socket is not connected when stream is finished writing, wait until data is
      // flushed to network at "connect" event.
      // TODO: is there a more reliable way to accomplish this?
      self.once('connect', function () {
        setTimeout(function () {
          self._destroy()
        }, 100)
      })
    }
  })
}

Socket.WEBSOCKET_SUPPORT = !!WebSocket

/**
 * Send text/binary data to the WebSocket server.
 * @param {TypedArrayView|ArrayBuffer|Buffer|string|Blob|Object} chunk
 */
Socket.prototype.send = function (chunk) {
  var self = this

  var len = chunk.length || chunk.byteLength || chunk.size
  self._ws.send(chunk)
  debug('write: %d bytes', len)
}

Socket.prototype.destroy = function (onclose) {
  var self = this
  self._destroy(null, onclose)
}

Socket.prototype._destroy = function (err, onclose) {
  var self = this
  if (self.destroyed) return
  if (onclose) self.once('close', onclose)

  debug('destroy (error: %s)', err && err.message)

  this.readable = this.writable = false

  if (!self._readableState.ended) self.push(null)
  if (!self._writableState.finished) self.end()

  self.connected = false
  self.destroyed = true

  clearInterval(self._interval)
  self._interval = null
  self._chunk = null
  self._cb = null

  if (self._ws) {
    var ws = self._ws
    var onClose = function () {
      ws.onclose = null
      self.emit('close')
    }
    if (ws.readyState === WebSocket.CLOSED) {
      onClose()
    } else {
      try {
        ws.onclose = onClose
        ws.close()
      } catch (err) {
        onClose()
      }
    }

    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
  }
  self._ws = null

  if (err) self.emit('error', err)
}

Socket.prototype._read = function () {}

Socket.prototype._write = function (chunk, encoding, cb) {
  var self = this
  if (self.destroyed) return cb(new Error('cannot write after socket is destroyed'))

  if (self.connected) {
    try {
      self.send(chunk)
    } catch (err) {
      return self._onError(err)
    }
    if (typeof ws !== 'function' && self._ws.bufferedAmount > self._maxBufferedAmount) {
      debug('start backpressure: bufferedAmount %d', self._ws.bufferedAmount)
      self._cb = cb
    } else {
      cb(null)
    }
  } else {
    debug('write before connect')
    self._chunk = chunk
    self._cb = cb
  }
}

Socket.prototype._onMessage = function (event) {
  var self = this
  if (self.destroyed) return
  var data = event.data
  debug('read: %d bytes', data.byteLength || data.length)

  if (data instanceof ArrayBuffer) data = new Buffer(data)
  self.push(data)
}

Socket.prototype._onOpen = function () {
  var self = this
  if (self.connected || self.destroyed) return
  self.connected = true

  if (self._chunk) {
    try {
      self.send(self._chunk)
    } catch (err) {
      return self._onError(err)
    }
    self._chunk = null
    debug('sent chunk from "write before connect"')

    var cb = self._cb
    self._cb = null
    cb(null)
  }

  // No backpressure in node. The `ws` module has a buggy `bufferedAmount` property.
  // See: https://github.com/websockets/ws/issues/492
  if (typeof ws !== 'function') {
    self._interval = setInterval(function () {
      if (!self._cb || !self._ws || self._ws.bufferedAmount > self._maxBufferedAmount) {
        return
      }
      debug('ending backpressure: bufferedAmount %d', self._ws.bufferedAmount)
      var cb = self._cb
      self._cb = null
      cb(null)
    }, 150)
    if (self._interval.unref) self._interval.unref()
  }

  debug('connect')
  self.emit('connect')
}

Socket.prototype._onClose = function () {
  var self = this
  if (self.destroyed) return
  debug('on close')
  self._destroy()
}

Socket.prototype._onError = function (err) {
  var self = this
  if (self.destroyed) return
  debug('error: %s', err.message || err)
  self._destroy(err)
}

}).call(this,require('_process'),require("buffer").Buffer)
},{"_process":33,"buffer":25,"debug":93,"inherits":101,"readable-stream":133,"ws":24}],23:[function(require,module,exports){

},{}],24:[function(require,module,exports){
arguments[4][23][0].apply(exports,arguments)
},{"dup":23}],25:[function(require,module,exports){
(function (global){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')
var isArray = require('isarray')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50
Buffer.poolSize = 8192 // not used by this implementation

var rootParent = {}

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * Due to various browser bugs, sometimes the Object implementation will be used even
 * when the browser supports typed arrays.
 *
 * Note:
 *
 *   - Firefox 4-29 lacks support for adding new properties to `Uint8Array` instances,
 *     See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438.
 *
 *   - Chrome 9-10 is missing the `TypedArray.prototype.subarray` function.
 *
 *   - IE10 has a broken `TypedArray.prototype.subarray` function which returns arrays of
 *     incorrect length in some situations.

 * We detect these buggy browsers and set `Buffer.TYPED_ARRAY_SUPPORT` to `false` so they
 * get the Object implementation, which is slower but behaves correctly.
 */
Buffer.TYPED_ARRAY_SUPPORT = global.TYPED_ARRAY_SUPPORT !== undefined
  ? global.TYPED_ARRAY_SUPPORT
  : typedArraySupport()

function typedArraySupport () {
  try {
    var arr = new Uint8Array(1)
    arr.foo = function () { return 42 }
    return arr.foo() === 42 && // typed array instances can be augmented
        typeof arr.subarray === 'function' && // chrome 9-10 lack `subarray`
        arr.subarray(1, 1).byteLength === 0 // ie10 has broken `subarray`
  } catch (e) {
    return false
  }
}

function kMaxLength () {
  return Buffer.TYPED_ARRAY_SUPPORT
    ? 0x7fffffff
    : 0x3fffffff
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */
function Buffer (arg) {
  if (!(this instanceof Buffer)) {
    // Avoid going through an ArgumentsAdaptorTrampoline in the common case.
    if (arguments.length > 1) return new Buffer(arg, arguments[1])
    return new Buffer(arg)
  }

  if (!Buffer.TYPED_ARRAY_SUPPORT) {
    this.length = 0
    this.parent = undefined
  }

  // Common case.
  if (typeof arg === 'number') {
    return fromNumber(this, arg)
  }

  // Slightly less common case.
  if (typeof arg === 'string') {
    return fromString(this, arg, arguments.length > 1 ? arguments[1] : 'utf8')
  }

  // Unusual.
  return fromObject(this, arg)
}

// TODO: Legacy, not needed anymore. Remove in next major version.
Buffer._augment = function (arr) {
  arr.__proto__ = Buffer.prototype
  return arr
}

function fromNumber (that, length) {
  that = allocate(that, length < 0 ? 0 : checked(length) | 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) {
    for (var i = 0; i < length; i++) {
      that[i] = 0
    }
  }
  return that
}

function fromString (that, string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') encoding = 'utf8'

  // Assumption: byteLength() return value is always < kMaxLength.
  var length = byteLength(string, encoding) | 0
  that = allocate(that, length)

  that.write(string, encoding)
  return that
}

function fromObject (that, object) {
  if (Buffer.isBuffer(object)) return fromBuffer(that, object)

  if (isArray(object)) return fromArray(that, object)

  if (object == null) {
    throw new TypeError('must start with number, buffer, array or string')
  }

  if (typeof ArrayBuffer !== 'undefined') {
    if (object.buffer instanceof ArrayBuffer) {
      return fromTypedArray(that, object)
    }
    if (object instanceof ArrayBuffer) {
      return fromArrayBuffer(that, object)
    }
  }

  if (object.length) return fromArrayLike(that, object)

  return fromJsonObject(that, object)
}

function fromBuffer (that, buffer) {
  var length = checked(buffer.length) | 0
  that = allocate(that, length)
  buffer.copy(that, 0, 0, length)
  return that
}

function fromArray (that, array) {
  var length = checked(array.length) | 0
  that = allocate(that, length)
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

// Duplicate of fromArray() to keep fromArray() monomorphic.
function fromTypedArray (that, array) {
  var length = checked(array.length) | 0
  that = allocate(that, length)
  // Truncating the elements is probably not what people expect from typed
  // arrays with BYTES_PER_ELEMENT > 1 but it's compatible with the behavior
  // of the old Buffer constructor.
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

function fromArrayBuffer (that, array) {
  array.byteLength // this throws if `array` is not a valid ArrayBuffer

  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    that = new Uint8Array(array)
    that.__proto__ = Buffer.prototype
  } else {
    // Fallback: Return an object instance of the Buffer class
    that = fromTypedArray(that, new Uint8Array(array))
  }
  return that
}

function fromArrayLike (that, array) {
  var length = checked(array.length) | 0
  that = allocate(that, length)
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

// Deserialize { type: 'Buffer', data: [1,2,3,...] } into a Buffer object.
// Returns a zero-length buffer for inputs that don't conform to the spec.
function fromJsonObject (that, object) {
  var array
  var length = 0

  if (object.type === 'Buffer' && isArray(object.data)) {
    array = object.data
    length = checked(array.length) | 0
  }
  that = allocate(that, length)

  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

if (Buffer.TYPED_ARRAY_SUPPORT) {
  Buffer.prototype.__proto__ = Uint8Array.prototype
  Buffer.__proto__ = Uint8Array
  if (typeof Symbol !== 'undefined' && Symbol.species &&
      Buffer[Symbol.species] === Buffer) {
    // Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
    Object.defineProperty(Buffer, Symbol.species, {
      value: null,
      configurable: true
    })
  }
} else {
  // pre-set for values that may exist in the future
  Buffer.prototype.length = undefined
  Buffer.prototype.parent = undefined
}

function allocate (that, length) {
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    that = new Uint8Array(length)
    that.__proto__ = Buffer.prototype
  } else {
    // Fallback: Return an object instance of the Buffer class
    that.length = length
  }

  var fromPool = length !== 0 && length <= Buffer.poolSize >>> 1
  if (fromPool) that.parent = rootParent

  return that
}

function checked (length) {
  // Note: cannot use `length < kMaxLength` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= kMaxLength()) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + kMaxLength().toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (subject, encoding) {
  if (!(this instanceof SlowBuffer)) return new SlowBuffer(subject, encoding)

  var buf = new Buffer(subject, encoding)
  delete buf.parent
  return buf
}

Buffer.isBuffer = function isBuffer (b) {
  return !!(b != null && b._isBuffer)
}

Buffer.compare = function compare (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError('Arguments must be Buffers')
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  var i = 0
  var len = Math.min(x, y)
  while (i < len) {
    if (a[i] !== b[i]) break

    ++i
  }

  if (i !== len) {
    x = a[i]
    y = b[i]
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'binary':
    case 'base64':
    case 'raw':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!isArray(list)) throw new TypeError('list argument must be an Array of Buffers.')

  if (list.length === 0) {
    return new Buffer(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; i++) {
      length += list[i].length
    }
  }

  var buf = new Buffer(length)
  var pos = 0
  for (i = 0; i < list.length; i++) {
    var item = list[i]
    item.copy(buf, pos)
    pos += item.length
  }
  return buf
}

function byteLength (string, encoding) {
  if (typeof string !== 'string') string = '' + string

  var len = string.length
  if (len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'binary':
      // Deprecated
      case 'raw':
      case 'raws':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) return utf8ToBytes(string).length // assume utf8
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  start = start | 0
  end = end === undefined || end === Infinity ? this.length : end | 0

  if (!encoding) encoding = 'utf8'
  if (start < 0) start = 0
  if (end > this.length) end = this.length
  if (end <= start) return ''

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'binary':
        return binarySlice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// The property is used by `Buffer.isBuffer` and `is-buffer` (in Safari 5-7) to detect
// Buffer instances.
Buffer.prototype._isBuffer = true

Buffer.prototype.toString = function toString () {
  var length = this.length | 0
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max) str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return 0
  return Buffer.compare(this, b)
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset) {
  if (byteOffset > 0x7fffffff) byteOffset = 0x7fffffff
  else if (byteOffset < -0x80000000) byteOffset = -0x80000000
  byteOffset >>= 0

  if (this.length === 0) return -1
  if (byteOffset >= this.length) return -1

  // Negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = Math.max(this.length + byteOffset, 0)

  if (typeof val === 'string') {
    if (val.length === 0) return -1 // special case: looking for empty string always fails
    return String.prototype.indexOf.call(this, val, byteOffset)
  }
  if (Buffer.isBuffer(val)) {
    return arrayIndexOf(this, val, byteOffset)
  }
  if (typeof val === 'number') {
    if (Buffer.TYPED_ARRAY_SUPPORT && Uint8Array.prototype.indexOf === 'function') {
      return Uint8Array.prototype.indexOf.call(this, val, byteOffset)
    }
    return arrayIndexOf(this, [ val ], byteOffset)
  }

  function arrayIndexOf (arr, val, byteOffset) {
    var foundIndex = -1
    for (var i = 0; byteOffset + i < arr.length; i++) {
      if (arr[byteOffset + i] === val[foundIndex === -1 ? 0 : i - foundIndex]) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === val.length) return byteOffset + foundIndex
      } else {
        foundIndex = -1
      }
    }
    return -1
  }

  throw new TypeError('val must be string, number or Buffer')
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  if (strLen % 2 !== 0) throw new Error('Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; i++) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (isNaN(parsed)) throw new Error('Invalid hex string')
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function binaryWrite (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset | 0
    if (isFinite(length)) {
      length = length | 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  // legacy write(string, encoding, offset, length) - remove in v0.13
  } else {
    var swap = encoding
    encoding = offset
    offset = length | 0
    length = swap
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'binary':
        return binaryWrite(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
      : (firstByte > 0xBF) ? 2
      : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function binarySlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; i++) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256)
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    newBuf = this.subarray(start, end)
    newBuf.__proto__ = Buffer.prototype
  } else {
    var sliceLen = end - start
    newBuf = new Buffer(sliceLen, undefined)
    for (var i = 0; i < sliceLen; i++) {
      newBuf[i] = this[i + start]
    }
  }

  if (newBuf.length) newBuf.parent = this.parent || this

  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('buffer must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('value is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  this[offset] = (value & 0xff)
  return offset + 1
}

function objectWriteUInt16 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 2); i < j; i++) {
    buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
      (littleEndian ? i : 1 - i) * 8
  }
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

function objectWriteUInt32 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffffffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 4); i < j; i++) {
    buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset + 3] = (value >>> 24)
    this[offset + 2] = (value >>> 16)
    this[offset + 1] = (value >>> 8)
    this[offset] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = value < 0 ? 1 : 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = value < 0 ? 1 : 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
    this[offset + 2] = (value >>> 16)
    this[offset + 3] = (value >>> 24)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('index out of range')
  if (offset < 0) throw new RangeError('index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('sourceStart out of bounds')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start
  var i

  if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (i = len - 1; i >= 0; i--) {
      target[i + targetStart] = this[i + start]
    }
  } else if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
    // ascending copy from start
    for (i = 0; i < len; i++) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, start + len),
      targetStart
    )
  }

  return len
}

// fill(value, start=0, end=buffer.length)
Buffer.prototype.fill = function fill (value, start, end) {
  if (!value) value = 0
  if (!start) start = 0
  if (!end) end = this.length

  if (end < start) throw new RangeError('end < start')

  // Fill 0 bytes; we're done
  if (end === start) return
  if (this.length === 0) return

  if (start < 0 || start >= this.length) throw new RangeError('start out of bounds')
  if (end < 0 || end > this.length) throw new RangeError('end out of bounds')

  var i
  if (typeof value === 'number') {
    for (i = start; i < end; i++) {
      this[i] = value
    }
  } else {
    var bytes = utf8ToBytes(value.toString())
    var len = bytes.length
    for (i = start; i < end; i++) {
      this[i] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+\/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; i++) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; i++) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"base64-js":26,"ieee754":27,"isarray":28}],26:[function(require,module,exports){
;(function (exports) {
  'use strict'

  var i
  var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  var lookup = []
  for (i = 0; i < code.length; i++) {
    lookup[i] = code[i]
  }
  var revLookup = []

  for (i = 0; i < code.length; ++i) {
    revLookup[code.charCodeAt(i)] = i
  }
  revLookup['-'.charCodeAt(0)] = 62
  revLookup['_'.charCodeAt(0)] = 63

  var Arr = (typeof Uint8Array !== 'undefined')
    ? Uint8Array
    : Array

  function decode (elt) {
    var v = revLookup[elt.charCodeAt(0)]
    return v !== undefined ? v : -1
  }

  function b64ToByteArray (b64) {
    var i, j, l, tmp, placeHolders, arr

    if (b64.length % 4 > 0) {
      throw new Error('Invalid string. Length must be a multiple of 4')
    }

    // the number of equal signs (place holders)
    // if there are two placeholders, than the two characters before it
    // represent one byte
    // if there is only one, then the three characters before it represent 2 bytes
    // this is just a cheap hack to not do indexOf twice
    var len = b64.length
    placeHolders = b64.charAt(len - 2) === '=' ? 2 : b64.charAt(len - 1) === '=' ? 1 : 0

    // base64 is 4/3 + up to two characters of the original data
    arr = new Arr(b64.length * 3 / 4 - placeHolders)

    // if there are placeholders, only get up to the last complete 4 chars
    l = placeHolders > 0 ? b64.length - 4 : b64.length

    var L = 0

    function push (v) {
      arr[L++] = v
    }

    for (i = 0, j = 0; i < l; i += 4, j += 3) {
      tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3))
      push((tmp & 0xFF0000) >> 16)
      push((tmp & 0xFF00) >> 8)
      push(tmp & 0xFF)
    }

    if (placeHolders === 2) {
      tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4)
      push(tmp & 0xFF)
    } else if (placeHolders === 1) {
      tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2)
      push((tmp >> 8) & 0xFF)
      push(tmp & 0xFF)
    }

    return arr
  }

  function encode (num) {
    return lookup[num]
  }

  function tripletToBase64 (num) {
    return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F)
  }

  function encodeChunk (uint8, start, end) {
    var temp
    var output = []
    for (var i = start; i < end; i += 3) {
      temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
      output.push(tripletToBase64(temp))
    }
    return output.join('')
  }

  function uint8ToBase64 (uint8) {
    var i
    var extraBytes = uint8.length % 3 // if we have 1 byte left, pad 2 bytes
    var output = ''
    var parts = []
    var temp, length
    var maxChunkLength = 16383 // must be multiple of 3

    // go through the array every three bytes, we'll deal with trailing stuff later

    for (i = 0, length = uint8.length - extraBytes; i < length; i += maxChunkLength) {
      parts.push(encodeChunk(uint8, i, (i + maxChunkLength) > length ? length : (i + maxChunkLength)))
    }

    // pad the end with zeros, but make sure to not forget the extra bytes
    switch (extraBytes) {
      case 1:
        temp = uint8[uint8.length - 1]
        output += encode(temp >> 2)
        output += encode((temp << 4) & 0x3F)
        output += '=='
        break
      case 2:
        temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1])
        output += encode(temp >> 10)
        output += encode((temp >> 4) & 0x3F)
        output += encode((temp << 2) & 0x3F)
        output += '='
        break
      default:
        break
    }

    parts.push(output)

    return parts.join('')
  }

  exports.toByteArray = b64ToByteArray
  exports.fromByteArray = uint8ToBase64
}(typeof exports === 'undefined' ? (this.base64js = {}) : exports))

},{}],27:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],28:[function(require,module,exports){
var toString = {}.toString;

module.exports = Array.isArray || function (arr) {
  return toString.call(arr) == '[object Array]';
};

},{}],29:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      }
      throw TypeError('Uncaught, unspecified "error" event.');
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    args = Array.prototype.slice.call(arguments, 1);
    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else if (listeners) {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.prototype.listenerCount = function(type) {
  if (this._events) {
    var evlistener = this._events[type];

    if (isFunction(evlistener))
      return 1;
    else if (evlistener)
      return evlistener.length;
  }
  return 0;
};

EventEmitter.listenerCount = function(emitter, type) {
  return emitter.listenerCount(type);
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],30:[function(require,module,exports){
var http = require('http');

var https = module.exports;

for (var key in http) {
    if (http.hasOwnProperty(key)) https[key] = http[key];
};

https.request = function (params, cb) {
    if (!params) params = {};
    params.scheme = 'https';
    params.protocol = 'https:';
    return http.request.call(this, params, cb);
}

},{"http":39}],31:[function(require,module,exports){
/**
 * Determine if an object is Buffer
 *
 * Author:   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * License:  MIT
 *
 * `npm install is-buffer`
 */

module.exports = function (obj) {
  return !!(obj != null &&
    (obj._isBuffer || // For Safari 5-7 (missing Object.prototype.constructor)
      (obj.constructor &&
      typeof obj.constructor.isBuffer === 'function' &&
      obj.constructor.isBuffer(obj))
    ))
}

},{}],32:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// resolves . and .. elements in a path array with directory names there
// must be no slashes, empty elements, or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = parts.length - 1; i >= 0; i--) {
    var last = parts[i];
    if (last === '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (allowAboveRoot) {
    for (; up--; up) {
      parts.unshift('..');
    }
  }

  return parts;
}

// Split a filename into [root, dir, basename, ext], unix version
// 'root' is just a slash, or nothing.
var splitPathRe =
    /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
var splitPath = function(filename) {
  return splitPathRe.exec(filename).slice(1);
};

// path.resolve([from ...], to)
// posix version
exports.resolve = function() {
  var resolvedPath = '',
      resolvedAbsolute = false;

  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    var path = (i >= 0) ? arguments[i] : process.cwd();

    // Skip empty and invalid entries
    if (typeof path !== 'string') {
      throw new TypeError('Arguments to path.resolve must be strings');
    } else if (!path) {
      continue;
    }

    resolvedPath = path + '/' + resolvedPath;
    resolvedAbsolute = path.charAt(0) === '/';
  }

  // At this point the path should be resolved to a full absolute path, but
  // handle relative paths to be safe (might happen when process.cwd() fails)

  // Normalize the path
  resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
    return !!p;
  }), !resolvedAbsolute).join('/');

  return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
};

// path.normalize(path)
// posix version
exports.normalize = function(path) {
  var isAbsolute = exports.isAbsolute(path),
      trailingSlash = substr(path, -1) === '/';

  // Normalize the path
  path = normalizeArray(filter(path.split('/'), function(p) {
    return !!p;
  }), !isAbsolute).join('/');

  if (!path && !isAbsolute) {
    path = '.';
  }
  if (path && trailingSlash) {
    path += '/';
  }

  return (isAbsolute ? '/' : '') + path;
};

// posix version
exports.isAbsolute = function(path) {
  return path.charAt(0) === '/';
};

// posix version
exports.join = function() {
  var paths = Array.prototype.slice.call(arguments, 0);
  return exports.normalize(filter(paths, function(p, index) {
    if (typeof p !== 'string') {
      throw new TypeError('Arguments to path.join must be strings');
    }
    return p;
  }).join('/'));
};


// path.relative(from, to)
// posix version
exports.relative = function(from, to) {
  from = exports.resolve(from).substr(1);
  to = exports.resolve(to).substr(1);

  function trim(arr) {
    var start = 0;
    for (; start < arr.length; start++) {
      if (arr[start] !== '') break;
    }

    var end = arr.length - 1;
    for (; end >= 0; end--) {
      if (arr[end] !== '') break;
    }

    if (start > end) return [];
    return arr.slice(start, end - start + 1);
  }

  var fromParts = trim(from.split('/'));
  var toParts = trim(to.split('/'));

  var length = Math.min(fromParts.length, toParts.length);
  var samePartsLength = length;
  for (var i = 0; i < length; i++) {
    if (fromParts[i] !== toParts[i]) {
      samePartsLength = i;
      break;
    }
  }

  var outputParts = [];
  for (var i = samePartsLength; i < fromParts.length; i++) {
    outputParts.push('..');
  }

  outputParts = outputParts.concat(toParts.slice(samePartsLength));

  return outputParts.join('/');
};

exports.sep = '/';
exports.delimiter = ':';

exports.dirname = function(path) {
  var result = splitPath(path),
      root = result[0],
      dir = result[1];

  if (!root && !dir) {
    // No dirname whatsoever
    return '.';
  }

  if (dir) {
    // It has a dirname, strip trailing slash
    dir = dir.substr(0, dir.length - 1);
  }

  return root + dir;
};


exports.basename = function(path, ext) {
  var f = splitPath(path)[2];
  // TODO: make this comparison case-insensitive on windows?
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
};


exports.extname = function(path) {
  return splitPath(path)[3];
};

function filter (xs, f) {
    if (xs.filter) return xs.filter(f);
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        if (f(xs[i], i, xs)) res.push(xs[i]);
    }
    return res;
}

// String.prototype.substr - negative index don't work in IE8
var substr = 'ab'.substr(-1) === 'b'
    ? function (str, start, len) { return str.substr(start, len) }
    : function (str, start, len) {
        if (start < 0) start = str.length + start;
        return str.substr(start, len);
    }
;

}).call(this,require('_process'))
},{"_process":33}],33:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        setTimeout(drainQueue, 0);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],34:[function(require,module,exports){
(function (global){
/*! https://mths.be/punycode v1.4.0 by @mathias */
;(function(root) {

	/** Detect free variables */
	var freeExports = typeof exports == 'object' && exports &&
		!exports.nodeType && exports;
	var freeModule = typeof module == 'object' && module &&
		!module.nodeType && module;
	var freeGlobal = typeof global == 'object' && global;
	if (
		freeGlobal.global === freeGlobal ||
		freeGlobal.window === freeGlobal ||
		freeGlobal.self === freeGlobal
	) {
		root = freeGlobal;
	}

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^\x20-\x7E]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw new RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		var result = [];
		while (length--) {
			result[length] = fn(array[length]);
		}
		return result;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings or email
	 * addresses.
	 * @private
	 * @param {String} domain The domain name or email address.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		var parts = string.split('@');
		var result = '';
		if (parts.length > 1) {
			// In email addresses, only the domain name should be punycoded. Leave
			// the local part (i.e. everything up to `@`) intact.
			result = parts[0] + '@';
			string = parts[1];
		}
		// Avoid `split(regex)` for IE8 compatibility. See #17.
		string = string.replace(regexSeparators, '\x2E');
		var labels = string.split('.');
		var encoded = map(labels, fn).join('.');
		return result + encoded;
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <https://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * https://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols (e.g. a domain name label) to a
	 * Punycode string of ASCII-only symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name or an email address
	 * to Unicode. Only the Punycoded parts of the input will be converted, i.e.
	 * it doesn't matter if you call it on a string that has already been
	 * converted to Unicode.
	 * @memberOf punycode
	 * @param {String} input The Punycoded domain name or email address to
	 * convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(input) {
		return mapDomain(input, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name or an email address to
	 * Punycode. Only the non-ASCII parts of the domain name will be converted,
	 * i.e. it doesn't matter if you call it with a domain that's already in
	 * ASCII.
	 * @memberOf punycode
	 * @param {String} input The domain name or email address to convert, as a
	 * Unicode string.
	 * @returns {String} The Punycode representation of the given domain name or
	 * email address.
	 */
	function toASCII(input) {
		return mapDomain(input, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		'version': '1.3.2',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <https://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		'ucs2': {
			'decode': ucs2decode,
			'encode': ucs2encode
		},
		'decode': decode,
		'encode': encode,
		'toASCII': toASCII,
		'toUnicode': toUnicode
	};

	/** Expose `punycode` */
	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define('punycode', function() {
			return punycode;
		});
	} else if (freeExports && freeModule) {
		if (module.exports == freeExports) {
			// in Node.js, io.js, or RingoJS v0.8.0+
			freeModule.exports = punycode;
		} else {
			// in Narwhal or RingoJS v0.7.0-
			for (key in punycode) {
				punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
			}
		}
	} else {
		// in Rhino or a web browser
		root.punycode = punycode;
	}

}(this));

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],35:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

module.exports = function(qs, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  var obj = {};

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  var regexp = /\+/g;
  qs = qs.split(sep);

  var maxKeys = 1000;
  if (options && typeof options.maxKeys === 'number') {
    maxKeys = options.maxKeys;
  }

  var len = qs.length;
  // maxKeys <= 0 means that we should not limit keys count
  if (maxKeys > 0 && len > maxKeys) {
    len = maxKeys;
  }

  for (var i = 0; i < len; ++i) {
    var x = qs[i].replace(regexp, '%20'),
        idx = x.indexOf(eq),
        kstr, vstr, k, v;

    if (idx >= 0) {
      kstr = x.substr(0, idx);
      vstr = x.substr(idx + 1);
    } else {
      kstr = x;
      vstr = '';
    }

    k = decodeURIComponent(kstr);
    v = decodeURIComponent(vstr);

    if (!hasOwnProperty(obj, k)) {
      obj[k] = v;
    } else if (isArray(obj[k])) {
      obj[k].push(v);
    } else {
      obj[k] = [obj[k], v];
    }
  }

  return obj;
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

},{}],36:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var stringifyPrimitive = function(v) {
  switch (typeof v) {
    case 'string':
      return v;

    case 'boolean':
      return v ? 'true' : 'false';

    case 'number':
      return isFinite(v) ? v : '';

    default:
      return '';
  }
};

module.exports = function(obj, sep, eq, name) {
  sep = sep || '&';
  eq = eq || '=';
  if (obj === null) {
    obj = undefined;
  }

  if (typeof obj === 'object') {
    return map(objectKeys(obj), function(k) {
      var ks = encodeURIComponent(stringifyPrimitive(k)) + eq;
      if (isArray(obj[k])) {
        return map(obj[k], function(v) {
          return ks + encodeURIComponent(stringifyPrimitive(v));
        }).join(sep);
      } else {
        return ks + encodeURIComponent(stringifyPrimitive(obj[k]));
      }
    }).join(sep);

  }

  if (!name) return '';
  return encodeURIComponent(stringifyPrimitive(name)) + eq +
         encodeURIComponent(stringifyPrimitive(obj));
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

function map (xs, f) {
  if (xs.map) return xs.map(f);
  var res = [];
  for (var i = 0; i < xs.length; i++) {
    res.push(f(xs[i], i));
  }
  return res;
}

var objectKeys = Object.keys || function (obj) {
  var res = [];
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) res.push(key);
  }
  return res;
};

},{}],37:[function(require,module,exports){
'use strict';

exports.decode = exports.parse = require('./decode');
exports.encode = exports.stringify = require('./encode');

},{"./decode":35,"./encode":36}],38:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

module.exports = Stream;

var EE = require('events').EventEmitter;
var inherits = require('inherits');

inherits(Stream, EE);
Stream.Readable = require('readable-stream/readable.js');
Stream.Writable = require('readable-stream/writable.js');
Stream.Duplex = require('readable-stream/duplex.js');
Stream.Transform = require('readable-stream/transform.js');
Stream.PassThrough = require('readable-stream/passthrough.js');

// Backwards-compat with node 0.4.x
Stream.Stream = Stream;



// old-style streams.  Note that the pipe method (the only relevant
// part of this class) is overridden in the Readable class.

function Stream() {
  EE.call(this);
}

Stream.prototype.pipe = function(dest, options) {
  var source = this;

  function ondata(chunk) {
    if (dest.writable) {
      if (false === dest.write(chunk) && source.pause) {
        source.pause();
      }
    }
  }

  source.on('data', ondata);

  function ondrain() {
    if (source.readable && source.resume) {
      source.resume();
    }
  }

  dest.on('drain', ondrain);

  // If the 'end' option is not supplied, dest.end() will be called when
  // source gets the 'end' or 'close' events.  Only dest.end() once.
  if (!dest._isStdio && (!options || options.end !== false)) {
    source.on('end', onend);
    source.on('close', onclose);
  }

  var didOnEnd = false;
  function onend() {
    if (didOnEnd) return;
    didOnEnd = true;

    dest.end();
  }


  function onclose() {
    if (didOnEnd) return;
    didOnEnd = true;

    if (typeof dest.destroy === 'function') dest.destroy();
  }

  // don't leave dangling pipes when there are errors.
  function onerror(er) {
    cleanup();
    if (EE.listenerCount(this, 'error') === 0) {
      throw er; // Unhandled stream error in pipe.
    }
  }

  source.on('error', onerror);
  dest.on('error', onerror);

  // remove all the event listeners that were added.
  function cleanup() {
    source.removeListener('data', ondata);
    dest.removeListener('drain', ondrain);

    source.removeListener('end', onend);
    source.removeListener('close', onclose);

    source.removeListener('error', onerror);
    dest.removeListener('error', onerror);

    source.removeListener('end', cleanup);
    source.removeListener('close', cleanup);

    dest.removeListener('close', cleanup);
  }

  source.on('end', cleanup);
  source.on('close', cleanup);

  dest.on('close', cleanup);

  dest.emit('pipe', source);

  // Allow for unix-like usage: A.pipe(B).pipe(C)
  return dest;
};

},{"events":29,"inherits":101,"readable-stream/duplex.js":121,"readable-stream/passthrough.js":132,"readable-stream/readable.js":133,"readable-stream/transform.js":134,"readable-stream/writable.js":135}],39:[function(require,module,exports){
(function (global){
var ClientRequest = require('./lib/request')
var extend = require('xtend')
var statusCodes = require('builtin-status-codes')
var url = require('url')

var http = exports

http.request = function (opts, cb) {
	if (typeof opts === 'string')
		opts = url.parse(opts)
	else
		opts = extend(opts)

	// Normally, the page is loaded from http or https, so not specifying a protocol
	// will result in a (valid) protocol-relative url. However, this won't work if
	// the protocol is something else, like 'file:'
	var defaultProtocol = global.location.protocol.search(/^https?:$/) === -1 ? 'http:' : ''

	var protocol = opts.protocol || defaultProtocol
	var host = opts.hostname || opts.host
	var port = opts.port
	var path = opts.path || '/'

	// Necessary for IPv6 addresses
	if (host && host.indexOf(':') !== -1)
		host = '[' + host + ']'

	// This may be a relative url. The browser should always be able to interpret it correctly.
	opts.url = (host ? (protocol + '//' + host) : '') + (port ? ':' + port : '') + path
	opts.method = (opts.method || 'GET').toUpperCase()
	opts.headers = opts.headers || {}

	// Also valid opts.auth, opts.mode

	var req = new ClientRequest(opts)
	if (cb)
		req.on('response', cb)
	return req
}

http.get = function get (opts, cb) {
	var req = http.request(opts, cb)
	req.end()
	return req
}

http.Agent = function () {}
http.Agent.defaultMaxSockets = 4

http.STATUS_CODES = statusCodes

http.METHODS = [
	'CHECKOUT',
	'CONNECT',
	'COPY',
	'DELETE',
	'GET',
	'HEAD',
	'LOCK',
	'M-SEARCH',
	'MERGE',
	'MKACTIVITY',
	'MKCOL',
	'MOVE',
	'NOTIFY',
	'OPTIONS',
	'PATCH',
	'POST',
	'PROPFIND',
	'PROPPATCH',
	'PURGE',
	'PUT',
	'REPORT',
	'SEARCH',
	'SUBSCRIBE',
	'TRACE',
	'UNLOCK',
	'UNSUBSCRIBE'
]
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./lib/request":41,"builtin-status-codes":43,"url":45,"xtend":172}],40:[function(require,module,exports){
(function (global){
exports.fetch = isFunction(global.fetch) && isFunction(global.ReadableByteStream)

exports.blobConstructor = false
try {
	new Blob([new ArrayBuffer(1)])
	exports.blobConstructor = true
} catch (e) {}

var xhr = new global.XMLHttpRequest()
// If location.host is empty, e.g. if this page/worker was loaded
// from a Blob, then use example.com to avoid an error
xhr.open('GET', global.location.host ? '/' : 'https://example.com')

function checkTypeSupport (type) {
	try {
		xhr.responseType = type
		return xhr.responseType === type
	} catch (e) {}
	return false
}

// For some strange reason, Safari 7.0 reports typeof global.ArrayBuffer === 'object'.
// Safari 7.1 appears to have fixed this bug.
var haveArrayBuffer = typeof global.ArrayBuffer !== 'undefined'
var haveSlice = haveArrayBuffer && isFunction(global.ArrayBuffer.prototype.slice)

exports.arraybuffer = haveArrayBuffer && checkTypeSupport('arraybuffer')
// These next two tests unavoidably show warnings in Chrome. Since fetch will always
// be used if it's available, just return false for these to avoid the warnings.
exports.msstream = !exports.fetch && haveSlice && checkTypeSupport('ms-stream')
exports.mozchunkedarraybuffer = !exports.fetch && haveArrayBuffer &&
	checkTypeSupport('moz-chunked-arraybuffer')
exports.overrideMimeType = isFunction(xhr.overrideMimeType)
exports.vbArray = isFunction(global.VBArray)

function isFunction (value) {
  return typeof value === 'function'
}

xhr = null // Help gc

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],41:[function(require,module,exports){
(function (process,global,Buffer){
// var Base64 = require('Base64')
var capability = require('./capability')
var inherits = require('inherits')
var response = require('./response')
var stream = require('stream')
var toArrayBuffer = require('to-arraybuffer')

var IncomingMessage = response.IncomingMessage
var rStates = response.readyStates

function decideMode (preferBinary) {
	if (capability.fetch) {
		return 'fetch'
	} else if (capability.mozchunkedarraybuffer) {
		return 'moz-chunked-arraybuffer'
	} else if (capability.msstream) {
		return 'ms-stream'
	} else if (capability.arraybuffer && preferBinary) {
		return 'arraybuffer'
	} else if (capability.vbArray && preferBinary) {
		return 'text:vbarray'
	} else {
		return 'text'
	}
}

var ClientRequest = module.exports = function (opts) {
	var self = this
	stream.Writable.call(self)

	self._opts = opts
	self._body = []
	self._headers = {}
	if (opts.auth)
		self.setHeader('Authorization', 'Basic ' + new Buffer(opts.auth).toString('base64'))
	Object.keys(opts.headers).forEach(function (name) {
		self.setHeader(name, opts.headers[name])
	})

	var preferBinary
	if (opts.mode === 'prefer-streaming') {
		// If streaming is a high priority but binary compatibility and
		// the accuracy of the 'content-type' header aren't
		preferBinary = false
	} else if (opts.mode === 'allow-wrong-content-type') {
		// If streaming is more important than preserving the 'content-type' header
		preferBinary = !capability.overrideMimeType
	} else if (!opts.mode || opts.mode === 'default' || opts.mode === 'prefer-fast') {
		// Use binary if text streaming may corrupt data or the content-type header, or for speed
		preferBinary = true
	} else {
		throw new Error('Invalid value for opts.mode')
	}
	self._mode = decideMode(preferBinary)

	self.on('finish', function () {
		self._onFinish()
	})
}

inherits(ClientRequest, stream.Writable)

ClientRequest.prototype.setHeader = function (name, value) {
	var self = this
	var lowerName = name.toLowerCase()
	// This check is not necessary, but it prevents warnings from browsers about setting unsafe
	// headers. To be honest I'm not entirely sure hiding these warnings is a good thing, but
	// http-browserify did it, so I will too.
	if (unsafeHeaders.indexOf(lowerName) !== -1)
		return

	self._headers[lowerName] = {
		name: name,
		value: value
	}
}

ClientRequest.prototype.getHeader = function (name) {
	var self = this
	return self._headers[name.toLowerCase()].value
}

ClientRequest.prototype.removeHeader = function (name) {
	var self = this
	delete self._headers[name.toLowerCase()]
}

ClientRequest.prototype._onFinish = function () {
	var self = this

	if (self._destroyed)
		return
	var opts = self._opts

	var headersObj = self._headers
	var body
	if (opts.method === 'POST' || opts.method === 'PUT' || opts.method === 'PATCH') {
		if (capability.blobConstructor) {
			body = new global.Blob(self._body.map(function (buffer) {
				return toArrayBuffer(buffer)
			}), {
				type: (headersObj['content-type'] || {}).value || ''
			})
		} else {
			// get utf8 string
			body = Buffer.concat(self._body).toString()
		}
	}

	if (self._mode === 'fetch') {
		var headers = Object.keys(headersObj).map(function (name) {
			return [headersObj[name].name, headersObj[name].value]
		})

		global.fetch(self._opts.url, {
			method: self._opts.method,
			headers: headers,
			body: body,
			mode: 'cors',
			credentials: opts.withCredentials ? 'include' : 'same-origin'
		}).then(function (response) {
			self._fetchResponse = response
			self._connect()
		}, function (reason) {
			self.emit('error', reason)
		})
	} else {
		var xhr = self._xhr = new global.XMLHttpRequest()
		try {
			xhr.open(self._opts.method, self._opts.url, true)
		} catch (err) {
			process.nextTick(function () {
				self.emit('error', err)
			})
			return
		}

		// Can't set responseType on really old browsers
		if ('responseType' in xhr)
			xhr.responseType = self._mode.split(':')[0]

		if ('withCredentials' in xhr)
			xhr.withCredentials = !!opts.withCredentials

		if (self._mode === 'text' && 'overrideMimeType' in xhr)
			xhr.overrideMimeType('text/plain; charset=x-user-defined')

		Object.keys(headersObj).forEach(function (name) {
			xhr.setRequestHeader(headersObj[name].name, headersObj[name].value)
		})

		self._response = null
		xhr.onreadystatechange = function () {
			switch (xhr.readyState) {
				case rStates.LOADING:
				case rStates.DONE:
					self._onXHRProgress()
					break
			}
		}
		// Necessary for streaming in Firefox, since xhr.response is ONLY defined
		// in onprogress, not in onreadystatechange with xhr.readyState = 3
		if (self._mode === 'moz-chunked-arraybuffer') {
			xhr.onprogress = function () {
				self._onXHRProgress()
			}
		}

		xhr.onerror = function () {
			if (self._destroyed)
				return
			self.emit('error', new Error('XHR error'))
		}

		try {
			xhr.send(body)
		} catch (err) {
			process.nextTick(function () {
				self.emit('error', err)
			})
			return
		}
	}
}

/**
 * Checks if xhr.status is readable and non-zero, indicating no error.
 * Even though the spec says it should be available in readyState 3,
 * accessing it throws an exception in IE8
 */
function statusValid (xhr) {
	try {
		var status = xhr.status
		return (status !== null && status !== 0)
	} catch (e) {
		return false
	}
}

ClientRequest.prototype._onXHRProgress = function () {
	var self = this

	if (!statusValid(self._xhr) || self._destroyed)
		return

	if (!self._response)
		self._connect()

	self._response._onXHRProgress()
}

ClientRequest.prototype._connect = function () {
	var self = this

	if (self._destroyed)
		return

	self._response = new IncomingMessage(self._xhr, self._fetchResponse, self._mode)
	self.emit('response', self._response)
}

ClientRequest.prototype._write = function (chunk, encoding, cb) {
	var self = this

	self._body.push(chunk)
	cb()
}

ClientRequest.prototype.abort = ClientRequest.prototype.destroy = function () {
	var self = this
	self._destroyed = true
	if (self._response)
		self._response._destroyed = true
	if (self._xhr)
		self._xhr.abort()
	// Currently, there isn't a way to truly abort a fetch.
	// If you like bikeshedding, see https://github.com/whatwg/fetch/issues/27
}

ClientRequest.prototype.end = function (data, encoding, cb) {
	var self = this
	if (typeof data === 'function') {
		cb = data
		data = undefined
	}

	stream.Writable.prototype.end.call(self, data, encoding, cb)
}

ClientRequest.prototype.flushHeaders = function () {}
ClientRequest.prototype.setTimeout = function () {}
ClientRequest.prototype.setNoDelay = function () {}
ClientRequest.prototype.setSocketKeepAlive = function () {}

// Taken from http://www.w3.org/TR/XMLHttpRequest/#the-setrequestheader%28%29-method
var unsafeHeaders = [
	'accept-charset',
	'accept-encoding',
	'access-control-request-headers',
	'access-control-request-method',
	'connection',
	'content-length',
	'cookie',
	'cookie2',
	'date',
	'dnt',
	'expect',
	'host',
	'keep-alive',
	'origin',
	'referer',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'user-agent',
	'via'
]

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},require("buffer").Buffer)
},{"./capability":40,"./response":42,"_process":33,"buffer":25,"inherits":101,"stream":38,"to-arraybuffer":44}],42:[function(require,module,exports){
(function (process,global,Buffer){
var capability = require('./capability')
var inherits = require('inherits')
var stream = require('stream')

var rStates = exports.readyStates = {
	UNSENT: 0,
	OPENED: 1,
	HEADERS_RECEIVED: 2,
	LOADING: 3,
	DONE: 4
}

var IncomingMessage = exports.IncomingMessage = function (xhr, response, mode) {
	var self = this
	stream.Readable.call(self)

	self._mode = mode
	self.headers = {}
	self.rawHeaders = []
	self.trailers = {}
	self.rawTrailers = []

	// Fake the 'close' event, but only once 'end' fires
	self.on('end', function () {
		// The nextTick is necessary to prevent the 'request' module from causing an infinite loop
		process.nextTick(function () {
			self.emit('close')
		})
	})

	if (mode === 'fetch') {
		self._fetchResponse = response

		self.statusCode = response.status
		self.statusMessage = response.statusText
		// backwards compatible version of for (<item> of <iterable>):
		// for (var <item>,_i,_it = <iterable>[Symbol.iterator](); <item> = (_i = _it.next()).value,!_i.done;)
		for (var header, _i, _it = response.headers[Symbol.iterator](); header = (_i = _it.next()).value, !_i.done;) {
			self.headers[header[0].toLowerCase()] = header[1]
			self.rawHeaders.push(header[0], header[1])
		}

		// TODO: this doesn't respect backpressure. Once WritableStream is available, this can be fixed
		var reader = response.body.getReader()
		function read () {
			reader.read().then(function (result) {
				if (self._destroyed)
					return
				if (result.done) {
					self.push(null)
					return
				}
				self.push(new Buffer(result.value))
				read()
			})
		}
		read()

	} else {
		self._xhr = xhr
		self._pos = 0

		self.statusCode = xhr.status
		self.statusMessage = xhr.statusText
		var headers = xhr.getAllResponseHeaders().split(/\r?\n/)
		headers.forEach(function (header) {
			var matches = header.match(/^([^:]+):\s*(.*)/)
			if (matches) {
				var key = matches[1].toLowerCase()
				if (self.headers[key] !== undefined)
					self.headers[key] += ', ' + matches[2]
				else
					self.headers[key] = matches[2]
				self.rawHeaders.push(matches[1], matches[2])
			}
		})

		self._charset = 'x-user-defined'
		if (!capability.overrideMimeType) {
			var mimeType = self.rawHeaders['mime-type']
			if (mimeType) {
				var charsetMatch = mimeType.match(/;\s*charset=([^;])(;|$)/)
				if (charsetMatch) {
					self._charset = charsetMatch[1].toLowerCase()
				}
			}
			if (!self._charset)
				self._charset = 'utf-8' // best guess
		}
	}
}

inherits(IncomingMessage, stream.Readable)

IncomingMessage.prototype._read = function () {}

IncomingMessage.prototype._onXHRProgress = function () {
	var self = this

	var xhr = self._xhr

	var response = null
	switch (self._mode) {
		case 'text:vbarray': // For IE9
			if (xhr.readyState !== rStates.DONE)
				break
			try {
				// This fails in IE8
				response = new global.VBArray(xhr.responseBody).toArray()
			} catch (e) {}
			if (response !== null) {
				self.push(new Buffer(response))
				break
			}
			// Falls through in IE8	
		case 'text':
			try { // This will fail when readyState = 3 in IE9. Switch mode and wait for readyState = 4
				response = xhr.responseText
			} catch (e) {
				self._mode = 'text:vbarray'
				break
			}
			if (response.length > self._pos) {
				var newData = response.substr(self._pos)
				if (self._charset === 'x-user-defined') {
					var buffer = new Buffer(newData.length)
					for (var i = 0; i < newData.length; i++)
						buffer[i] = newData.charCodeAt(i) & 0xff

					self.push(buffer)
				} else {
					self.push(newData, self._charset)
				}
				self._pos = response.length
			}
			break
		case 'arraybuffer':
			if (xhr.readyState !== rStates.DONE)
				break
			response = xhr.response
			self.push(new Buffer(new Uint8Array(response)))
			break
		case 'moz-chunked-arraybuffer': // take whole
			response = xhr.response
			if (xhr.readyState !== rStates.LOADING || !response)
				break
			self.push(new Buffer(new Uint8Array(response)))
			break
		case 'ms-stream':
			response = xhr.response
			if (xhr.readyState !== rStates.LOADING)
				break
			var reader = new global.MSStreamReader()
			reader.onprogress = function () {
				if (reader.result.byteLength > self._pos) {
					self.push(new Buffer(new Uint8Array(reader.result.slice(self._pos))))
					self._pos = reader.result.byteLength
				}
			}
			reader.onload = function () {
				self.push(null)
			}
			// reader.onerror = ??? // TODO: this
			reader.readAsArrayBuffer(response)
			break
	}

	// The ms-stream case handles end separately in reader.onload()
	if (self._xhr.readyState === rStates.DONE && self._mode !== 'ms-stream') {
		self.push(null)
	}
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},require("buffer").Buffer)
},{"./capability":40,"_process":33,"buffer":25,"inherits":101,"stream":38}],43:[function(require,module,exports){
module.exports = {
  "100": "Continue",
  "101": "Switching Protocols",
  "102": "Processing",
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "203": "Non-Authoritative Information",
  "204": "No Content",
  "205": "Reset Content",
  "206": "Partial Content",
  "207": "Multi-Status",
  "208": "Already Reported",
  "226": "IM Used",
  "300": "Multiple Choices",
  "301": "Moved Permanently",
  "302": "Found",
  "303": "See Other",
  "304": "Not Modified",
  "305": "Use Proxy",
  "307": "Temporary Redirect",
  "308": "Permanent Redirect",
  "400": "Bad Request",
  "401": "Unauthorized",
  "402": "Payment Required",
  "403": "Forbidden",
  "404": "Not Found",
  "405": "Method Not Allowed",
  "406": "Not Acceptable",
  "407": "Proxy Authentication Required",
  "408": "Request Timeout",
  "409": "Conflict",
  "410": "Gone",
  "411": "Length Required",
  "412": "Precondition Failed",
  "413": "Payload Too Large",
  "414": "URI Too Long",
  "415": "Unsupported Media Type",
  "416": "Range Not Satisfiable",
  "417": "Expectation Failed",
  "418": "I'm a teapot",
  "421": "Misdirected Request",
  "422": "Unprocessable Entity",
  "423": "Locked",
  "424": "Failed Dependency",
  "425": "Unordered Collection",
  "426": "Upgrade Required",
  "428": "Precondition Required",
  "429": "Too Many Requests",
  "431": "Request Header Fields Too Large",
  "500": "Internal Server Error",
  "501": "Not Implemented",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
  "504": "Gateway Timeout",
  "505": "HTTP Version Not Supported",
  "506": "Variant Also Negotiates",
  "507": "Insufficient Storage",
  "508": "Loop Detected",
  "509": "Bandwidth Limit Exceeded",
  "510": "Not Extended",
  "511": "Network Authentication Required"
}

},{}],44:[function(require,module,exports){
var Buffer = require('buffer').Buffer

module.exports = function (buf) {
	// If the buffer is backed by a Uint8Array, a faster version will work
	if (buf instanceof Uint8Array) {
		// If the buffer isn't a subarray, return the underlying ArrayBuffer
		if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
			return buf.buffer
		} else if (typeof buf.buffer.slice === 'function') {
			// Otherwise we need to get a proper copy
			return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
		}
	}

	if (Buffer.isBuffer(buf)) {
		// This is the slow version that will work with any Buffer
		// implementation (even in old browsers)
		var arrayCopy = new Uint8Array(buf.length)
		var len = buf.length
		for (var i = 0; i < len; i++) {
			arrayCopy[i] = buf[i]
		}
		return arrayCopy.buffer
	} else {
		throw new Error('Argument must be a Buffer')
	}
}

},{"buffer":25}],45:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var punycode = require('punycode');
var util = require('./util');

exports.parse = urlParse;
exports.resolve = urlResolve;
exports.resolveObject = urlResolveObject;
exports.format = urlFormat;

exports.Url = Url;

function Url() {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
}

// Reference: RFC 3986, RFC 1808, RFC 2396

// define these here so at least they only have to be
// compiled once on the first module load.
var protocolPattern = /^([a-z0-9.+-]+:)/i,
    portPattern = /:[0-9]*$/,

    // Special case for a simple path URL
    simplePathPattern = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/,

    // RFC 2396: characters reserved for delimiting URLs.
    // We actually just auto-escape these.
    delims = ['<', '>', '"', '`', ' ', '\r', '\n', '\t'],

    // RFC 2396: characters not allowed for various reasons.
    unwise = ['{', '}', '|', '\\', '^', '`'].concat(delims),

    // Allowed by RFCs, but cause of XSS attacks.  Always escape these.
    autoEscape = ['\''].concat(unwise),
    // Characters that are never ever allowed in a hostname.
    // Note that any invalid chars are also handled, but these
    // are the ones that are *expected* to be seen, so we fast-path
    // them.
    nonHostChars = ['%', '/', '?', ';', '#'].concat(autoEscape),
    hostEndingChars = ['/', '?', '#'],
    hostnameMaxLen = 255,
    hostnamePartPattern = /^[+a-z0-9A-Z_-]{0,63}$/,
    hostnamePartStart = /^([+a-z0-9A-Z_-]{0,63})(.*)$/,
    // protocols that can allow "unsafe" and "unwise" chars.
    unsafeProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that never have a hostname.
    hostlessProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that always contain a // bit.
    slashedProtocol = {
      'http': true,
      'https': true,
      'ftp': true,
      'gopher': true,
      'file': true,
      'http:': true,
      'https:': true,
      'ftp:': true,
      'gopher:': true,
      'file:': true
    },
    querystring = require('querystring');

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (url && util.isObject(url) && url instanceof Url) return url;

  var u = new Url;
  u.parse(url, parseQueryString, slashesDenoteHost);
  return u;
}

Url.prototype.parse = function(url, parseQueryString, slashesDenoteHost) {
  if (!util.isString(url)) {
    throw new TypeError("Parameter 'url' must be a string, not " + typeof url);
  }

  // Copy chrome, IE, opera backslash-handling behavior.
  // Back slashes before the query string get converted to forward slashes
  // See: https://code.google.com/p/chromium/issues/detail?id=25916
  var queryIndex = url.indexOf('?'),
      splitter =
          (queryIndex !== -1 && queryIndex < url.indexOf('#')) ? '?' : '#',
      uSplit = url.split(splitter),
      slashRegex = /\\/g;
  uSplit[0] = uSplit[0].replace(slashRegex, '/');
  url = uSplit.join(splitter);

  var rest = url;

  // trim before proceeding.
  // This is to support parse stuff like "  http://foo.com  \n"
  rest = rest.trim();

  if (!slashesDenoteHost && url.split('#').length === 1) {
    // Try fast path regexp
    var simplePath = simplePathPattern.exec(rest);
    if (simplePath) {
      this.path = rest;
      this.href = rest;
      this.pathname = simplePath[1];
      if (simplePath[2]) {
        this.search = simplePath[2];
        if (parseQueryString) {
          this.query = querystring.parse(this.search.substr(1));
        } else {
          this.query = this.search.substr(1);
        }
      } else if (parseQueryString) {
        this.search = '';
        this.query = {};
      }
      return this;
    }
  }

  var proto = protocolPattern.exec(rest);
  if (proto) {
    proto = proto[0];
    var lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.substr(proto.length);
  }

  // figure out if it's got a host
  // user@server is *always* interpreted as a hostname, and url
  // resolution will treat //foo/bar as host=foo,path=bar because that's
  // how the browser resolves relative URLs.
  if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
    var slashes = rest.substr(0, 2) === '//';
    if (slashes && !(proto && hostlessProtocol[proto])) {
      rest = rest.substr(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol[proto] &&
      (slashes || (proto && !slashedProtocol[proto]))) {

    // there's a hostname.
    // the first instance of /, ?, ;, or # ends the host.
    //
    // If there is an @ in the hostname, then non-host chars *are* allowed
    // to the left of the last @ sign, unless some host-ending character
    // comes *before* the @-sign.
    // URLs are obnoxious.
    //
    // ex:
    // http://a@b@c/ => user:a@b host:c
    // http://a@b?@c => user:a host:c path:/?@c

    // v0.12 TODO(isaacs): This is not quite how Chrome does things.
    // Review our test case against browsers more comprehensively.

    // find the first instance of any hostEndingChars
    var hostEnd = -1;
    for (var i = 0; i < hostEndingChars.length; i++) {
      var hec = rest.indexOf(hostEndingChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }

    // at this point, either we have an explicit point where the
    // auth portion cannot go past, or the last @ char is the decider.
    var auth, atSign;
    if (hostEnd === -1) {
      // atSign can be anywhere.
      atSign = rest.lastIndexOf('@');
    } else {
      // atSign must be in auth portion.
      // http://a@b/c@d => host:b auth:a path:/c@d
      atSign = rest.lastIndexOf('@', hostEnd);
    }

    // Now we have a portion which is definitely the auth.
    // Pull that off.
    if (atSign !== -1) {
      auth = rest.slice(0, atSign);
      rest = rest.slice(atSign + 1);
      this.auth = decodeURIComponent(auth);
    }

    // the host is the remaining to the left of the first non-host char
    hostEnd = -1;
    for (var i = 0; i < nonHostChars.length; i++) {
      var hec = rest.indexOf(nonHostChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }
    // if we still have not hit it, then the entire thing is a host.
    if (hostEnd === -1)
      hostEnd = rest.length;

    this.host = rest.slice(0, hostEnd);
    rest = rest.slice(hostEnd);

    // pull out port.
    this.parseHost();

    // we've indicated that there is a hostname,
    // so even if it's empty, it has to be present.
    this.hostname = this.hostname || '';

    // if hostname begins with [ and ends with ]
    // assume that it's an IPv6 address.
    var ipv6Hostname = this.hostname[0] === '[' &&
        this.hostname[this.hostname.length - 1] === ']';

    // validate a little.
    if (!ipv6Hostname) {
      var hostparts = this.hostname.split(/\./);
      for (var i = 0, l = hostparts.length; i < l; i++) {
        var part = hostparts[i];
        if (!part) continue;
        if (!part.match(hostnamePartPattern)) {
          var newpart = '';
          for (var j = 0, k = part.length; j < k; j++) {
            if (part.charCodeAt(j) > 127) {
              // we replace non-ASCII char with a temporary placeholder
              // we need this to make sure size of hostname is not
              // broken by replacing non-ASCII by nothing
              newpart += 'x';
            } else {
              newpart += part[j];
            }
          }
          // we test again with ASCII char only
          if (!newpart.match(hostnamePartPattern)) {
            var validParts = hostparts.slice(0, i);
            var notHost = hostparts.slice(i + 1);
            var bit = part.match(hostnamePartStart);
            if (bit) {
              validParts.push(bit[1]);
              notHost.unshift(bit[2]);
            }
            if (notHost.length) {
              rest = '/' + notHost.join('.') + rest;
            }
            this.hostname = validParts.join('.');
            break;
          }
        }
      }
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = '';
    } else {
      // hostnames are always lower case.
      this.hostname = this.hostname.toLowerCase();
    }

    if (!ipv6Hostname) {
      // IDNA Support: Returns a punycoded representation of "domain".
      // It only converts parts of the domain name that
      // have non-ASCII characters, i.e. it doesn't matter if
      // you call it with a domain that already is ASCII-only.
      this.hostname = punycode.toASCII(this.hostname);
    }

    var p = this.port ? ':' + this.port : '';
    var h = this.hostname || '';
    this.host = h + p;
    this.href += this.host;

    // strip [ and ] from the hostname
    // the host field still retains them, though
    if (ipv6Hostname) {
      this.hostname = this.hostname.substr(1, this.hostname.length - 2);
      if (rest[0] !== '/') {
        rest = '/' + rest;
      }
    }
  }

  // now rest is set to the post-host stuff.
  // chop off any delim chars.
  if (!unsafeProtocol[lowerProto]) {

    // First, make 100% sure that any "autoEscape" chars get
    // escaped, even if encodeURIComponent doesn't think they
    // need to be.
    for (var i = 0, l = autoEscape.length; i < l; i++) {
      var ae = autoEscape[i];
      if (rest.indexOf(ae) === -1)
        continue;
      var esc = encodeURIComponent(ae);
      if (esc === ae) {
        esc = escape(ae);
      }
      rest = rest.split(ae).join(esc);
    }
  }


  // chop off from the tail first.
  var hash = rest.indexOf('#');
  if (hash !== -1) {
    // got a fragment string.
    this.hash = rest.substr(hash);
    rest = rest.slice(0, hash);
  }
  var qm = rest.indexOf('?');
  if (qm !== -1) {
    this.search = rest.substr(qm);
    this.query = rest.substr(qm + 1);
    if (parseQueryString) {
      this.query = querystring.parse(this.query);
    }
    rest = rest.slice(0, qm);
  } else if (parseQueryString) {
    // no query string, but parseQueryString still requested
    this.search = '';
    this.query = {};
  }
  if (rest) this.pathname = rest;
  if (slashedProtocol[lowerProto] &&
      this.hostname && !this.pathname) {
    this.pathname = '/';
  }

  //to support http.request
  if (this.pathname || this.search) {
    var p = this.pathname || '';
    var s = this.search || '';
    this.path = p + s;
  }

  // finally, reconstruct the href based on what has been validated.
  this.href = this.format();
  return this;
};

// format a parsed object into a url string
function urlFormat(obj) {
  // ensure it's an object, and not a string url.
  // If it's an obj, this is a no-op.
  // this way, you can call url_format() on strings
  // to clean up potentially wonky urls.
  if (util.isString(obj)) obj = urlParse(obj);
  if (!(obj instanceof Url)) return Url.prototype.format.call(obj);
  return obj.format();
}

Url.prototype.format = function() {
  var auth = this.auth || '';
  if (auth) {
    auth = encodeURIComponent(auth);
    auth = auth.replace(/%3A/i, ':');
    auth += '@';
  }

  var protocol = this.protocol || '',
      pathname = this.pathname || '',
      hash = this.hash || '',
      host = false,
      query = '';

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (this.hostname.indexOf(':') === -1 ?
        this.hostname :
        '[' + this.hostname + ']');
    if (this.port) {
      host += ':' + this.port;
    }
  }

  if (this.query &&
      util.isObject(this.query) &&
      Object.keys(this.query).length) {
    query = querystring.stringify(this.query);
  }

  var search = this.search || (query && ('?' + query)) || '';

  if (protocol && protocol.substr(-1) !== ':') protocol += ':';

  // only the slashedProtocols get the //.  Not mailto:, xmpp:, etc.
  // unless they had them to begin with.
  if (this.slashes ||
      (!protocol || slashedProtocol[protocol]) && host !== false) {
    host = '//' + (host || '');
    if (pathname && pathname.charAt(0) !== '/') pathname = '/' + pathname;
  } else if (!host) {
    host = '';
  }

  if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
  if (search && search.charAt(0) !== '?') search = '?' + search;

  pathname = pathname.replace(/[?#]/g, function(match) {
    return encodeURIComponent(match);
  });
  search = search.replace('#', '%23');

  return protocol + host + pathname + search + hash;
};

function urlResolve(source, relative) {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function(relative) {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

function urlResolveObject(source, relative) {
  if (!source) return relative;
  return urlParse(source, false, true).resolveObject(relative);
}

Url.prototype.resolveObject = function(relative) {
  if (util.isString(relative)) {
    var rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  var result = new Url();
  var tkeys = Object.keys(this);
  for (var tk = 0; tk < tkeys.length; tk++) {
    var tkey = tkeys[tk];
    result[tkey] = this[tkey];
  }

  // hash is always overridden, no matter what.
  // even href="" will remove it.
  result.hash = relative.hash;

  // if the relative url is empty, then there's nothing left to do here.
  if (relative.href === '') {
    result.href = result.format();
    return result;
  }

  // hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    // take everything except the protocol from relative
    var rkeys = Object.keys(relative);
    for (var rk = 0; rk < rkeys.length; rk++) {
      var rkey = rkeys[rk];
      if (rkey !== 'protocol')
        result[rkey] = relative[rkey];
    }

    //urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol[result.protocol] &&
        result.hostname && !result.pathname) {
      result.path = result.pathname = '/';
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    // if it's a known url protocol, then changing
    // the protocol does weird things
    // first, if it's not file:, then we MUST have a host,
    // and if there was a path
    // to begin with, then we MUST have a path.
    // if it is file:, then the host is dropped,
    // because that's known to be hostless.
    // anything else is assumed to be absolute.
    if (!slashedProtocol[relative.protocol]) {
      var keys = Object.keys(relative);
      for (var v = 0; v < keys.length; v++) {
        var k = keys[v];
        result[k] = relative[k];
      }
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (!relative.host && !hostlessProtocol[relative.protocol]) {
      var relPath = (relative.pathname || '').split('/');
      while (relPath.length && !(relative.host = relPath.shift()));
      if (!relative.host) relative.host = '';
      if (!relative.hostname) relative.hostname = '';
      if (relPath[0] !== '') relPath.unshift('');
      if (relPath.length < 2) relPath.unshift('');
      result.pathname = relPath.join('/');
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || '';
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    // to support http.request
    if (result.pathname || result.search) {
      var p = result.pathname || '';
      var s = result.search || '';
      result.path = p + s;
    }
    result.slashes = result.slashes || relative.slashes;
    result.href = result.format();
    return result;
  }

  var isSourceAbs = (result.pathname && result.pathname.charAt(0) === '/'),
      isRelAbs = (
          relative.host ||
          relative.pathname && relative.pathname.charAt(0) === '/'
      ),
      mustEndAbs = (isRelAbs || isSourceAbs ||
                    (result.host && relative.pathname)),
      removeAllDots = mustEndAbs,
      srcPath = result.pathname && result.pathname.split('/') || [],
      relPath = relative.pathname && relative.pathname.split('/') || [],
      psychotic = result.protocol && !slashedProtocol[result.protocol];

  // if the url is a non-slashed url, then relative
  // links like ../.. should be able
  // to crawl up to the hostname, as well.  This is strange.
  // result.protocol has already been set by now.
  // Later on, put the first path part into the host field.
  if (psychotic) {
    result.hostname = '';
    result.port = null;
    if (result.host) {
      if (srcPath[0] === '') srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = '';
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      if (relative.host) {
        if (relPath[0] === '') relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      relative.host = null;
    }
    mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
  }

  if (isRelAbs) {
    // it's absolute.
    result.host = (relative.host || relative.host === '') ?
                  relative.host : result.host;
    result.hostname = (relative.hostname || relative.hostname === '') ?
                      relative.hostname : result.hostname;
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // fall through to the dot-handling below.
  } else if (relPath.length) {
    // it's relative
    // throw away the existing file, and take the new path instead.
    if (!srcPath) srcPath = [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (!util.isNullOrUndefined(relative.search)) {
    // just pull out the search.
    // like href='?foo'.
    // Put this after the other two cases because it simplifies the booleans
    if (psychotic) {
      result.hostname = result.host = srcPath.shift();
      //occationaly the auth can get stuck only in host
      //this especially happens in cases like
      //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
      var authInHost = result.host && result.host.indexOf('@') > 0 ?
                       result.host.split('@') : false;
      if (authInHost) {
        result.auth = authInHost.shift();
        result.host = result.hostname = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    //to support http.request
    if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
      result.path = (result.pathname ? result.pathname : '') +
                    (result.search ? result.search : '');
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    // no path at all.  easy.
    // we've already handled the other stuff above.
    result.pathname = null;
    //to support http.request
    if (result.search) {
      result.path = '/' + result.search;
    } else {
      result.path = null;
    }
    result.href = result.format();
    return result;
  }

  // if a url ENDs in . or .., then it must get a trailing slash.
  // however, if it ends in anything else non-slashy,
  // then it must NOT get a trailing slash.
  var last = srcPath.slice(-1)[0];
  var hasTrailingSlash = (
      (result.host || relative.host || srcPath.length > 1) &&
      (last === '.' || last === '..') || last === '');

  // strip single dots, resolve double dots to parent dir
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = srcPath.length; i >= 0; i--) {
    last = srcPath[i];
    if (last === '.') {
      srcPath.splice(i, 1);
    } else if (last === '..') {
      srcPath.splice(i, 1);
      up++;
    } else if (up) {
      srcPath.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    for (; up--; up) {
      srcPath.unshift('..');
    }
  }

  if (mustEndAbs && srcPath[0] !== '' &&
      (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
    srcPath.unshift('');
  }

  if (hasTrailingSlash && (srcPath.join('/').substr(-1) !== '/')) {
    srcPath.push('');
  }

  var isAbsolute = srcPath[0] === '' ||
      (srcPath[0] && srcPath[0].charAt(0) === '/');

  // put the host back
  if (psychotic) {
    result.hostname = result.host = isAbsolute ? '' :
                                    srcPath.length ? srcPath.shift() : '';
    //occationaly the auth can get stuck only in host
    //this especially happens in cases like
    //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
    var authInHost = result.host && result.host.indexOf('@') > 0 ?
                     result.host.split('@') : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.host = result.hostname = authInHost.shift();
    }
  }

  mustEndAbs = mustEndAbs || (result.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift('');
  }

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join('/');
  }

  //to support request.http
  if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
    result.path = (result.pathname ? result.pathname : '') +
                  (result.search ? result.search : '');
  }
  result.auth = relative.auth || result.auth;
  result.slashes = result.slashes || relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function() {
  var host = this.host;
  var port = portPattern.exec(host);
  if (port) {
    port = port[0];
    if (port !== ':') {
      this.port = port.substr(1);
    }
    host = host.substr(0, host.length - port.length);
  }
  if (host) this.hostname = host;
};

},{"./util":46,"punycode":34,"querystring":37}],46:[function(require,module,exports){
'use strict';

module.exports = {
  isString: function(arg) {
    return typeof(arg) === 'string';
  },
  isObject: function(arg) {
    return typeof(arg) === 'object' && arg !== null;
  },
  isNull: function(arg) {
    return arg === null;
  },
  isNullOrUndefined: function(arg) {
    return arg == null;
  }
};

},{}],47:[function(require,module,exports){
(function (Buffer){
var inherits = require('inherits');
var Transform = require('readable-stream').Transform;
var defined = require('defined');

module.exports = Block;
inherits(Block, Transform);

function Block (size, opts) {
    if (!(this instanceof Block)) return new Block(size, opts);
    Transform.call(this);
    if (!opts) opts = {};
    if (typeof size === 'object') {
        opts = size;
        size = opts.size;
    }
    this.size = size || 512;
    
    if (opts.nopad) this._zeroPadding = false;
    else this._zeroPadding = defined(opts.zeroPadding, true);
    
    this._buffered = [];
    this._bufferedBytes = 0;
}

Block.prototype._transform = function (buf, enc, next) {
    this._bufferedBytes += buf.length;
    this._buffered.push(buf);
    
    while (this._bufferedBytes >= this.size) {
        var b = Buffer.concat(this._buffered);
        this._bufferedBytes -= this.size;
        this.push(b.slice(0, this.size));
        this._buffered = [ b.slice(this.size, b.length) ];
    }
    next();
};

Block.prototype._flush = function () {
    if (this._bufferedBytes && this._zeroPadding) {
        var zeroes = new Buffer(this.size - this._bufferedBytes);
        zeroes.fill(0);
        this._buffered.push(zeroes);
        this.push(Buffer.concat(this._buffered));
        this._buffered = null;
    }
    else if (this._bufferedBytes) {
        this.push(Buffer.concat(this._buffered));
        this._buffered = null;
    }
    this.push(null);
};

}).call(this,require("buffer").Buffer)
},{"buffer":25,"defined":48,"inherits":101,"readable-stream":59}],48:[function(require,module,exports){
module.exports = function () {
    for (var i = 0; i < arguments.length; i++) {
        if (arguments[i] !== undefined) return arguments[i];
    }
};

},{}],49:[function(require,module,exports){
// a duplex stream is just a stream that is both readable and writable.
// Since JS doesn't have multiple prototypal inheritance, this class
// prototypally inherits from Readable, and then parasitically from
// Writable.

'use strict';

/*<replacement>*/
var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) keys.push(key);
  return keys;
}
/*</replacement>*/


module.exports = Duplex;

/*<replacement>*/
var processNextTick = require('process-nextick-args');
/*</replacement>*/



/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

var Readable = require('./_stream_readable');
var Writable = require('./_stream_writable');

util.inherits(Duplex, Readable);

var keys = objectKeys(Writable.prototype);
for (var v = 0; v < keys.length; v++) {
  var method = keys[v];
  if (!Duplex.prototype[method])
    Duplex.prototype[method] = Writable.prototype[method];
}

function Duplex(options) {
  if (!(this instanceof Duplex))
    return new Duplex(options);

  Readable.call(this, options);
  Writable.call(this, options);

  if (options && options.readable === false)
    this.readable = false;

  if (options && options.writable === false)
    this.writable = false;

  this.allowHalfOpen = true;
  if (options && options.allowHalfOpen === false)
    this.allowHalfOpen = false;

  this.once('end', onend);
}

// the no-half-open enforcer
function onend() {
  // if we allow half-open state, or if the writable side ended,
  // then we're ok.
  if (this.allowHalfOpen || this._writableState.ended)
    return;

  // no more data can be written.
  // But allow more writes to happen in this tick.
  processNextTick(onEndNT, this);
}

function onEndNT(self) {
  self.end();
}

function forEach (xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}

},{"./_stream_readable":51,"./_stream_writable":53,"core-util-is":54,"inherits":101,"process-nextick-args":56}],50:[function(require,module,exports){
// a passthrough stream.
// basically just the most minimal sort of Transform stream.
// Every written chunk gets output as-is.

'use strict';

module.exports = PassThrough;

var Transform = require('./_stream_transform');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(PassThrough, Transform);

function PassThrough(options) {
  if (!(this instanceof PassThrough))
    return new PassThrough(options);

  Transform.call(this, options);
}

PassThrough.prototype._transform = function(chunk, encoding, cb) {
  cb(null, chunk);
};

},{"./_stream_transform":52,"core-util-is":54,"inherits":101}],51:[function(require,module,exports){
(function (process){
'use strict';

module.exports = Readable;

/*<replacement>*/
var processNextTick = require('process-nextick-args');
/*</replacement>*/


/*<replacement>*/
var isArray = require('isarray');
/*</replacement>*/


/*<replacement>*/
var Buffer = require('buffer').Buffer;
/*</replacement>*/

Readable.ReadableState = ReadableState;

var EE = require('events');

/*<replacement>*/
var EElistenerCount = function(emitter, type) {
  return emitter.listeners(type).length;
};
/*</replacement>*/



/*<replacement>*/
var Stream;
(function (){try{
  Stream = require('st' + 'ream');
}catch(_){}finally{
  if (!Stream)
    Stream = require('events').EventEmitter;
}}())
/*</replacement>*/

var Buffer = require('buffer').Buffer;

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/



/*<replacement>*/
var debugUtil = require('util');
var debug;
if (debugUtil && debugUtil.debuglog) {
  debug = debugUtil.debuglog('stream');
} else {
  debug = function () {};
}
/*</replacement>*/

var StringDecoder;

util.inherits(Readable, Stream);

var Duplex;
function ReadableState(options, stream) {
  Duplex = Duplex || require('./_stream_duplex');

  options = options || {};

  // object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex)
    this.objectMode = this.objectMode || !!options.readableObjectMode;

  // the point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  var hwm = options.highWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = (hwm || hwm === 0) ? hwm : defaultHwm;

  // cast to ints.
  this.highWaterMark = ~~this.highWaterMark;

  this.buffer = [];
  this.length = 0;
  this.pipes = null;
  this.pipesCount = 0;
  this.flowing = null;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // when piping, we only care about 'readable' events that happen
  // after read()ing all the bytes and not getting any pushback.
  this.ranOut = false;

  // the number of writers that are awaiting a drain event in .pipe()s
  this.awaitDrain = 0;

  // if true, a maybeReadMore has been scheduled
  this.readingMore = false;

  this.decoder = null;
  this.encoding = null;
  if (options.encoding) {
    if (!StringDecoder)
      StringDecoder = require('string_decoder/').StringDecoder;
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

var Duplex;
function Readable(options) {
  Duplex = Duplex || require('./_stream_duplex');

  if (!(this instanceof Readable))
    return new Readable(options);

  this._readableState = new ReadableState(options, this);

  // legacy
  this.readable = true;

  if (options && typeof options.read === 'function')
    this._read = options.read;

  Stream.call(this);
}

// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function(chunk, encoding) {
  var state = this._readableState;

  if (!state.objectMode && typeof chunk === 'string') {
    encoding = encoding || state.defaultEncoding;
    if (encoding !== state.encoding) {
      chunk = new Buffer(chunk, encoding);
      encoding = '';
    }
  }

  return readableAddChunk(this, state, chunk, encoding, false);
};

// Unshift should *always* be something directly out of read()
Readable.prototype.unshift = function(chunk) {
  var state = this._readableState;
  return readableAddChunk(this, state, chunk, '', true);
};

Readable.prototype.isPaused = function() {
  return this._readableState.flowing === false;
};

function readableAddChunk(stream, state, chunk, encoding, addToFront) {
  var er = chunkInvalid(state, chunk);
  if (er) {
    stream.emit('error', er);
  } else if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
  } else if (state.objectMode || chunk && chunk.length > 0) {
    if (state.ended && !addToFront) {
      var e = new Error('stream.push() after EOF');
      stream.emit('error', e);
    } else if (state.endEmitted && addToFront) {
      var e = new Error('stream.unshift() after end event');
      stream.emit('error', e);
    } else {
      if (state.decoder && !addToFront && !encoding)
        chunk = state.decoder.write(chunk);

      if (!addToFront)
        state.reading = false;

      // if we want the data now, just emit it.
      if (state.flowing && state.length === 0 && !state.sync) {
        stream.emit('data', chunk);
        stream.read(0);
      } else {
        // update the buffer info.
        state.length += state.objectMode ? 1 : chunk.length;
        if (addToFront)
          state.buffer.unshift(chunk);
        else
          state.buffer.push(chunk);

        if (state.needReadable)
          emitReadable(stream);
      }

      maybeReadMore(stream, state);
    }
  } else if (!addToFront) {
    state.reading = false;
  }

  return needMoreData(state);
}


// if it's past the high water mark, we can push in some more.
// Also, if we have no data yet, we can stand some
// more bytes.  This is to work around cases where hwm=0,
// such as the repl.  Also, if the push() triggered a
// readable event, and the user called read(largeNumber) such that
// needReadable was set, then we ought to push more, so that another
// 'readable' event will be triggered.
function needMoreData(state) {
  return !state.ended &&
         (state.needReadable ||
          state.length < state.highWaterMark ||
          state.length === 0);
}

// backwards compatibility.
Readable.prototype.setEncoding = function(enc) {
  if (!StringDecoder)
    StringDecoder = require('string_decoder/').StringDecoder;
  this._readableState.decoder = new StringDecoder(enc);
  this._readableState.encoding = enc;
  return this;
};

// Don't raise the hwm > 8MB
var MAX_HWM = 0x800000;
function computeNewHighWaterMark(n) {
  if (n >= MAX_HWM) {
    n = MAX_HWM;
  } else {
    // Get the next highest power of 2
    n--;
    n |= n >>> 1;
    n |= n >>> 2;
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
    n++;
  }
  return n;
}

function howMuchToRead(n, state) {
  if (state.length === 0 && state.ended)
    return 0;

  if (state.objectMode)
    return n === 0 ? 0 : 1;

  if (n === null || isNaN(n)) {
    // only flow one buffer at a time
    if (state.flowing && state.buffer.length)
      return state.buffer[0].length;
    else
      return state.length;
  }

  if (n <= 0)
    return 0;

  // If we're asking for more than the target buffer level,
  // then raise the water mark.  Bump up to the next highest
  // power of 2, to prevent increasing it excessively in tiny
  // amounts.
  if (n > state.highWaterMark)
    state.highWaterMark = computeNewHighWaterMark(n);

  // don't have that much.  return null, unless we've ended.
  if (n > state.length) {
    if (!state.ended) {
      state.needReadable = true;
      return 0;
    } else {
      return state.length;
    }
  }

  return n;
}

// you can override either this method, or the async _read(n) below.
Readable.prototype.read = function(n) {
  debug('read', n);
  var state = this._readableState;
  var nOrig = n;

  if (typeof n !== 'number' || n > 0)
    state.emittedReadable = false;

  // if we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (n === 0 &&
      state.needReadable &&
      (state.length >= state.highWaterMark || state.ended)) {
    debug('read: emitReadable', state.length, state.ended);
    if (state.length === 0 && state.ended)
      endReadable(this);
    else
      emitReadable(this);
    return null;
  }

  n = howMuchToRead(n, state);

  // if we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) {
    if (state.length === 0)
      endReadable(this);
    return null;
  }

  // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.

  // if we need a readable event, then we need to do some reading.
  var doRead = state.needReadable;
  debug('need readable', doRead);

  // if we currently have less than the highWaterMark, then also read some
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
    debug('length less than watermark', doRead);
  }

  // however, if we've ended, then there's no point, and if we're already
  // reading, then it's unnecessary.
  if (state.ended || state.reading) {
    doRead = false;
    debug('reading or ended', doRead);
  }

  if (doRead) {
    debug('do read');
    state.reading = true;
    state.sync = true;
    // if the length is currently zero, then we *need* a readable event.
    if (state.length === 0)
      state.needReadable = true;
    // call internal read method
    this._read(state.highWaterMark);
    state.sync = false;
  }

  // If _read pushed data synchronously, then `reading` will be false,
  // and we need to re-evaluate how much data we can return to the user.
  if (doRead && !state.reading)
    n = howMuchToRead(nOrig, state);

  var ret;
  if (n > 0)
    ret = fromList(n, state);
  else
    ret = null;

  if (ret === null) {
    state.needReadable = true;
    n = 0;
  }

  state.length -= n;

  // If we have nothing in the buffer, then we want to know
  // as soon as we *do* get something into the buffer.
  if (state.length === 0 && !state.ended)
    state.needReadable = true;

  // If we tried to read() past the EOF, then emit end on the next tick.
  if (nOrig !== n && state.ended && state.length === 0)
    endReadable(this);

  if (ret !== null)
    this.emit('data', ret);

  return ret;
};

function chunkInvalid(state, chunk) {
  var er = null;
  if (!(Buffer.isBuffer(chunk)) &&
      typeof chunk !== 'string' &&
      chunk !== null &&
      chunk !== undefined &&
      !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  return er;
}


function onEofChunk(stream, state) {
  if (state.ended) return;
  if (state.decoder) {
    var chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  // emit 'readable' now to make sure it gets picked up.
  emitReadable(stream);
}

// Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.
function emitReadable(stream) {
  var state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    debug('emitReadable', state.flowing);
    state.emittedReadable = true;
    if (state.sync)
      processNextTick(emitReadable_, stream);
    else
      emitReadable_(stream);
  }
}

function emitReadable_(stream) {
  debug('emit readable');
  stream.emit('readable');
  flow(stream);
}


// at this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.
function maybeReadMore(stream, state) {
  if (!state.readingMore) {
    state.readingMore = true;
    processNextTick(maybeReadMore_, stream, state);
  }
}

function maybeReadMore_(stream, state) {
  var len = state.length;
  while (!state.reading && !state.flowing && !state.ended &&
         state.length < state.highWaterMark) {
    debug('maybeReadMore read 0');
    stream.read(0);
    if (len === state.length)
      // didn't get any data, stop spinning.
      break;
    else
      len = state.length;
  }
  state.readingMore = false;
}

// abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.
Readable.prototype._read = function(n) {
  this.emit('error', new Error('not implemented'));
};

Readable.prototype.pipe = function(dest, pipeOpts) {
  var src = this;
  var state = this._readableState;

  switch (state.pipesCount) {
    case 0:
      state.pipes = dest;
      break;
    case 1:
      state.pipes = [state.pipes, dest];
      break;
    default:
      state.pipes.push(dest);
      break;
  }
  state.pipesCount += 1;
  debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);

  var doEnd = (!pipeOpts || pipeOpts.end !== false) &&
              dest !== process.stdout &&
              dest !== process.stderr;

  var endFn = doEnd ? onend : cleanup;
  if (state.endEmitted)
    processNextTick(endFn);
  else
    src.once('end', endFn);

  dest.on('unpipe', onunpipe);
  function onunpipe(readable) {
    debug('onunpipe');
    if (readable === src) {
      cleanup();
    }
  }

  function onend() {
    debug('onend');
    dest.end();
  }

  // when the dest drains, it reduces the awaitDrain counter
  // on the source.  This would be more elegant with a .once()
  // handler in flow(), but adding and removing repeatedly is
  // too slow.
  var ondrain = pipeOnDrain(src);
  dest.on('drain', ondrain);

  var cleanedUp = false;
  function cleanup() {
    debug('cleanup');
    // cleanup event handlers once the pipe is broken
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    dest.removeListener('drain', ondrain);
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', cleanup);
    src.removeListener('data', ondata);

    cleanedUp = true;

    // if the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (state.awaitDrain &&
        (!dest._writableState || dest._writableState.needDrain))
      ondrain();
  }

  src.on('data', ondata);
  function ondata(chunk) {
    debug('ondata');
    var ret = dest.write(chunk);
    if (false === ret) {
      // If the user unpiped during `dest.write()`, it is possible
      // to get stuck in a permanently paused state if that write
      // also returned false.
      if (state.pipesCount === 1 &&
          state.pipes[0] === dest &&
          src.listenerCount('data') === 1 &&
          !cleanedUp) {
        debug('false write response, pause', src._readableState.awaitDrain);
        src._readableState.awaitDrain++;
      }
      src.pause();
    }
  }

  // if the dest has an error, then stop piping into it.
  // however, don't suppress the throwing behavior for this.
  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EElistenerCount(dest, 'error') === 0)
      dest.emit('error', er);
  }
  // This is a brutally ugly hack to make sure that our error handler
  // is attached before any userland ones.  NEVER DO THIS.
  if (!dest._events || !dest._events.error)
    dest.on('error', onerror);
  else if (isArray(dest._events.error))
    dest._events.error.unshift(onerror);
  else
    dest._events.error = [onerror, dest._events.error];


  // Both close and finish should trigger unpipe, but only once.
  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }
  dest.once('close', onclose);
  function onfinish() {
    debug('onfinish');
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);

  function unpipe() {
    debug('unpipe');
    src.unpipe(dest);
  }

  // tell the dest that it's being piped to
  dest.emit('pipe', src);

  // start the flow if it hasn't been started already.
  if (!state.flowing) {
    debug('pipe resume');
    src.resume();
  }

  return dest;
};

function pipeOnDrain(src) {
  return function() {
    var state = src._readableState;
    debug('pipeOnDrain', state.awaitDrain);
    if (state.awaitDrain)
      state.awaitDrain--;
    if (state.awaitDrain === 0 && EElistenerCount(src, 'data')) {
      state.flowing = true;
      flow(src);
    }
  };
}


Readable.prototype.unpipe = function(dest) {
  var state = this._readableState;

  // if we're not piping anywhere, then do nothing.
  if (state.pipesCount === 0)
    return this;

  // just one destination.  most common case.
  if (state.pipesCount === 1) {
    // passed in one, but it's not the right one.
    if (dest && dest !== state.pipes)
      return this;

    if (!dest)
      dest = state.pipes;

    // got a match.
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;
    if (dest)
      dest.emit('unpipe', this);
    return this;
  }

  // slow case. multiple pipe destinations.

  if (!dest) {
    // remove all.
    var dests = state.pipes;
    var len = state.pipesCount;
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;

    for (var i = 0; i < len; i++)
      dests[i].emit('unpipe', this);
    return this;
  }

  // try to find the right one.
  var i = indexOf(state.pipes, dest);
  if (i === -1)
    return this;

  state.pipes.splice(i, 1);
  state.pipesCount -= 1;
  if (state.pipesCount === 1)
    state.pipes = state.pipes[0];

  dest.emit('unpipe', this);

  return this;
};

// set up data events if they are asked for
// Ensure readable listeners eventually get something
Readable.prototype.on = function(ev, fn) {
  var res = Stream.prototype.on.call(this, ev, fn);

  // If listening to data, and it has not explicitly been paused,
  // then call resume to start the flow of data on the next tick.
  if (ev === 'data' && false !== this._readableState.flowing) {
    this.resume();
  }

  if (ev === 'readable' && this.readable) {
    var state = this._readableState;
    if (!state.readableListening) {
      state.readableListening = true;
      state.emittedReadable = false;
      state.needReadable = true;
      if (!state.reading) {
        processNextTick(nReadingNextTick, this);
      } else if (state.length) {
        emitReadable(this, state);
      }
    }
  }

  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

function nReadingNextTick(self) {
  debug('readable nexttick read 0');
  self.read(0);
}

// pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.
Readable.prototype.resume = function() {
  var state = this._readableState;
  if (!state.flowing) {
    debug('resume');
    state.flowing = true;
    resume(this, state);
  }
  return this;
};

function resume(stream, state) {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    processNextTick(resume_, stream, state);
  }
}

function resume_(stream, state) {
  if (!state.reading) {
    debug('resume read 0');
    stream.read(0);
  }

  state.resumeScheduled = false;
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading)
    stream.read(0);
}

Readable.prototype.pause = function() {
  debug('call pause flowing=%j', this._readableState.flowing);
  if (false !== this._readableState.flowing) {
    debug('pause');
    this._readableState.flowing = false;
    this.emit('pause');
  }
  return this;
};

function flow(stream) {
  var state = stream._readableState;
  debug('flow', state.flowing);
  if (state.flowing) {
    do {
      var chunk = stream.read();
    } while (null !== chunk && state.flowing);
  }
}

// wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function(stream) {
  var state = this._readableState;
  var paused = false;

  var self = this;
  stream.on('end', function() {
    debug('wrapped end');
    if (state.decoder && !state.ended) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length)
        self.push(chunk);
    }

    self.push(null);
  });

  stream.on('data', function(chunk) {
    debug('wrapped data');
    if (state.decoder)
      chunk = state.decoder.write(chunk);

    // don't skip over falsy values in objectMode
    if (state.objectMode && (chunk === null || chunk === undefined))
      return;
    else if (!state.objectMode && (!chunk || !chunk.length))
      return;

    var ret = self.push(chunk);
    if (!ret) {
      paused = true;
      stream.pause();
    }
  });

  // proxy all the other methods.
  // important when wrapping filters and duplexes.
  for (var i in stream) {
    if (this[i] === undefined && typeof stream[i] === 'function') {
      this[i] = function(method) { return function() {
        return stream[method].apply(stream, arguments);
      }; }(i);
    }
  }

  // proxy certain important events.
  var events = ['error', 'close', 'destroy', 'pause', 'resume'];
  forEach(events, function(ev) {
    stream.on(ev, self.emit.bind(self, ev));
  });

  // when we try to consume some more bytes, simply unpause the
  // underlying stream.
  self._read = function(n) {
    debug('wrapped _read', n);
    if (paused) {
      paused = false;
      stream.resume();
    }
  };

  return self;
};


// exposed for testing purposes only.
Readable._fromList = fromList;

// Pluck off n bytes from an array of buffers.
// Length is the combined lengths of all the buffers in the list.
function fromList(n, state) {
  var list = state.buffer;
  var length = state.length;
  var stringMode = !!state.decoder;
  var objectMode = !!state.objectMode;
  var ret;

  // nothing in the list, definitely empty.
  if (list.length === 0)
    return null;

  if (length === 0)
    ret = null;
  else if (objectMode)
    ret = list.shift();
  else if (!n || n >= length) {
    // read it all, truncate the array.
    if (stringMode)
      ret = list.join('');
    else if (list.length === 1)
      ret = list[0];
    else
      ret = Buffer.concat(list, length);
    list.length = 0;
  } else {
    // read just some of it.
    if (n < list[0].length) {
      // just take a part of the first list item.
      // slice is the same for buffers and strings.
      var buf = list[0];
      ret = buf.slice(0, n);
      list[0] = buf.slice(n);
    } else if (n === list[0].length) {
      // first list is a perfect match
      ret = list.shift();
    } else {
      // complex case.
      // we have enough to cover it, but it spans past the first buffer.
      if (stringMode)
        ret = '';
      else
        ret = new Buffer(n);

      var c = 0;
      for (var i = 0, l = list.length; i < l && c < n; i++) {
        var buf = list[0];
        var cpy = Math.min(n - c, buf.length);

        if (stringMode)
          ret += buf.slice(0, cpy);
        else
          buf.copy(ret, c, 0, cpy);

        if (cpy < buf.length)
          list[0] = buf.slice(cpy);
        else
          list.shift();

        c += cpy;
      }
    }
  }

  return ret;
}

function endReadable(stream) {
  var state = stream._readableState;

  // If we get here before consuming all the bytes, then that is a
  // bug in node.  Should never happen.
  if (state.length > 0)
    throw new Error('endReadable called on non-empty stream');

  if (!state.endEmitted) {
    state.ended = true;
    processNextTick(endReadableNT, state, stream);
  }
}

function endReadableNT(state, stream) {
  // Check that we didn't get one last unshift.
  if (!state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.readable = false;
    stream.emit('end');
  }
}

function forEach (xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}

function indexOf (xs, x) {
  for (var i = 0, l = xs.length; i < l; i++) {
    if (xs[i] === x) return i;
  }
  return -1;
}

}).call(this,require('_process'))
},{"./_stream_duplex":49,"_process":33,"buffer":25,"core-util-is":54,"events":29,"inherits":101,"isarray":55,"process-nextick-args":56,"string_decoder/":57,"util":24}],52:[function(require,module,exports){
// a transform stream is a readable/writable stream where you do
// something with the data.  Sometimes it's called a "filter",
// but that's not a great name for it, since that implies a thing where
// some bits pass through, and others are simply ignored.  (That would
// be a valid example of a transform, of course.)
//
// While the output is causally related to the input, it's not a
// necessarily symmetric or synchronous transformation.  For example,
// a zlib stream might take multiple plain-text writes(), and then
// emit a single compressed chunk some time in the future.
//
// Here's how this works:
//
// The Transform stream has all the aspects of the readable and writable
// stream classes.  When you write(chunk), that calls _write(chunk,cb)
// internally, and returns false if there's a lot of pending writes
// buffered up.  When you call read(), that calls _read(n) until
// there's enough pending readable data buffered up.
//
// In a transform stream, the written data is placed in a buffer.  When
// _read(n) is called, it transforms the queued up data, calling the
// buffered _write cb's as it consumes chunks.  If consuming a single
// written chunk would result in multiple output chunks, then the first
// outputted bit calls the readcb, and subsequent chunks just go into
// the read buffer, and will cause it to emit 'readable' if necessary.
//
// This way, back-pressure is actually determined by the reading side,
// since _read has to be called to start processing a new chunk.  However,
// a pathological inflate type of transform can cause excessive buffering
// here.  For example, imagine a stream where every byte of input is
// interpreted as an integer from 0-255, and then results in that many
// bytes of output.  Writing the 4 bytes {ff,ff,ff,ff} would result in
// 1kb of data being output.  In this case, you could write a very small
// amount of input, and end up with a very large amount of output.  In
// such a pathological inflating mechanism, there'd be no way to tell
// the system to stop doing the transform.  A single 4MB write could
// cause the system to run out of memory.
//
// However, even in such a pathological case, only a single written chunk
// would be consumed, and then the rest would wait (un-transformed) until
// the results of the previous transformed chunk were consumed.

'use strict';

module.exports = Transform;

var Duplex = require('./_stream_duplex');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(Transform, Duplex);


function TransformState(stream) {
  this.afterTransform = function(er, data) {
    return afterTransform(stream, er, data);
  };

  this.needTransform = false;
  this.transforming = false;
  this.writecb = null;
  this.writechunk = null;
}

function afterTransform(stream, er, data) {
  var ts = stream._transformState;
  ts.transforming = false;

  var cb = ts.writecb;

  if (!cb)
    return stream.emit('error', new Error('no writecb in Transform class'));

  ts.writechunk = null;
  ts.writecb = null;

  if (data !== null && data !== undefined)
    stream.push(data);

  if (cb)
    cb(er);

  var rs = stream._readableState;
  rs.reading = false;
  if (rs.needReadable || rs.length < rs.highWaterMark) {
    stream._read(rs.highWaterMark);
  }
}


function Transform(options) {
  if (!(this instanceof Transform))
    return new Transform(options);

  Duplex.call(this, options);

  this._transformState = new TransformState(this);

  // when the writable side finishes, then flush out anything remaining.
  var stream = this;

  // start out asking for a readable event once data is transformed.
  this._readableState.needReadable = true;

  // we have implemented the _read method, and done the other things
  // that Readable wants before the first _read call, so unset the
  // sync guard flag.
  this._readableState.sync = false;

  if (options) {
    if (typeof options.transform === 'function')
      this._transform = options.transform;

    if (typeof options.flush === 'function')
      this._flush = options.flush;
  }

  this.once('prefinish', function() {
    if (typeof this._flush === 'function')
      this._flush(function(er) {
        done(stream, er);
      });
    else
      done(stream);
  });
}

Transform.prototype.push = function(chunk, encoding) {
  this._transformState.needTransform = false;
  return Duplex.prototype.push.call(this, chunk, encoding);
};

// This is the part where you do stuff!
// override this function in implementation classes.
// 'chunk' is an input chunk.
//
// Call `push(newChunk)` to pass along transformed output
// to the readable side.  You may call 'push' zero or more times.
//
// Call `cb(err)` when you are done with this chunk.  If you pass
// an error, then that'll put the hurt on the whole operation.  If you
// never call cb(), then you'll never get another chunk.
Transform.prototype._transform = function(chunk, encoding, cb) {
  throw new Error('not implemented');
};

Transform.prototype._write = function(chunk, encoding, cb) {
  var ts = this._transformState;
  ts.writecb = cb;
  ts.writechunk = chunk;
  ts.writeencoding = encoding;
  if (!ts.transforming) {
    var rs = this._readableState;
    if (ts.needTransform ||
        rs.needReadable ||
        rs.length < rs.highWaterMark)
      this._read(rs.highWaterMark);
  }
};

// Doesn't matter what the args are here.
// _transform does all the work.
// That we got here means that the readable side wants more data.
Transform.prototype._read = function(n) {
  var ts = this._transformState;

  if (ts.writechunk !== null && ts.writecb && !ts.transforming) {
    ts.transforming = true;
    this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
  } else {
    // mark that we need a transform, so that any data that comes in
    // will get processed, now that we've asked for it.
    ts.needTransform = true;
  }
};


function done(stream, er) {
  if (er)
    return stream.emit('error', er);

  // if there's nothing in the write buffer, then that means
  // that nothing more will ever be provided
  var ws = stream._writableState;
  var ts = stream._transformState;

  if (ws.length)
    throw new Error('calling transform done when ws.length != 0');

  if (ts.transforming)
    throw new Error('calling transform done when still transforming');

  return stream.push(null);
}

},{"./_stream_duplex":49,"core-util-is":54,"inherits":101}],53:[function(require,module,exports){
// A bit simpler than readable streams.
// Implement an async ._write(chunk, encoding, cb), and it'll handle all
// the drain event emission and buffering.

'use strict';

module.exports = Writable;

/*<replacement>*/
var processNextTick = require('process-nextick-args');
/*</replacement>*/


/*<replacement>*/
var Buffer = require('buffer').Buffer;
/*</replacement>*/

Writable.WritableState = WritableState;


/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/


/*<replacement>*/
var internalUtil = {
  deprecate: require('util-deprecate')
};
/*</replacement>*/



/*<replacement>*/
var Stream;
(function (){try{
  Stream = require('st' + 'ream');
}catch(_){}finally{
  if (!Stream)
    Stream = require('events').EventEmitter;
}}())
/*</replacement>*/

var Buffer = require('buffer').Buffer;

util.inherits(Writable, Stream);

function nop() {}

function WriteReq(chunk, encoding, cb) {
  this.chunk = chunk;
  this.encoding = encoding;
  this.callback = cb;
  this.next = null;
}

var Duplex;
function WritableState(options, stream) {
  Duplex = Duplex || require('./_stream_duplex');

  options = options || {};

  // object stream flag to indicate whether or not this stream
  // contains buffers or objects.
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex)
    this.objectMode = this.objectMode || !!options.writableObjectMode;

  // the point at which write() starts returning false
  // Note: 0 is a valid value, means that we always return false if
  // the entire buffer is not flushed immediately on write()
  var hwm = options.highWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = (hwm || hwm === 0) ? hwm : defaultHwm;

  // cast to ints.
  this.highWaterMark = ~~this.highWaterMark;

  this.needDrain = false;
  // at the start of calling end()
  this.ending = false;
  // when end() has been called, and returned
  this.ended = false;
  // when 'finish' is emitted
  this.finished = false;

  // should we decode strings into buffers before passing to _write?
  // this is here so that some node-core streams can optimize string
  // handling at a lower level.
  var noDecode = options.decodeStrings === false;
  this.decodeStrings = !noDecode;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // not an actual buffer we keep track of, but a measurement
  // of how much we're waiting to get pushed to some underlying
  // socket or file.
  this.length = 0;

  // a flag to see when we're in the middle of a write.
  this.writing = false;

  // when true all writes will be buffered until .uncork() call
  this.corked = 0;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // a flag to know if we're processing previously buffered items, which
  // may call the _write() callback in the same tick, so that we don't
  // end up in an overlapped onwrite situation.
  this.bufferProcessing = false;

  // the callback that's passed to _write(chunk,cb)
  this.onwrite = function(er) {
    onwrite(stream, er);
  };

  // the callback that the user supplies to write(chunk,encoding,cb)
  this.writecb = null;

  // the amount that is being written when _write is called.
  this.writelen = 0;

  this.bufferedRequest = null;
  this.lastBufferedRequest = null;

  // number of pending user-supplied write callbacks
  // this must be 0 before 'finish' can be emitted
  this.pendingcb = 0;

  // emit prefinish if the only thing we're waiting for is _write cbs
  // This is relevant for synchronous Transform streams
  this.prefinished = false;

  // True if the error was already emitted and should not be thrown again
  this.errorEmitted = false;
}

WritableState.prototype.getBuffer = function writableStateGetBuffer() {
  var current = this.bufferedRequest;
  var out = [];
  while (current) {
    out.push(current);
    current = current.next;
  }
  return out;
};

(function (){try {
Object.defineProperty(WritableState.prototype, 'buffer', {
  get: internalUtil.deprecate(function() {
    return this.getBuffer();
  }, '_writableState.buffer is deprecated. Use _writableState.getBuffer ' +
     'instead.')
});
}catch(_){}}());


var Duplex;
function Writable(options) {
  Duplex = Duplex || require('./_stream_duplex');

  // Writable ctor is applied to Duplexes, though they're not
  // instanceof Writable, they're instanceof Readable.
  if (!(this instanceof Writable) && !(this instanceof Duplex))
    return new Writable(options);

  this._writableState = new WritableState(options, this);

  // legacy.
  this.writable = true;

  if (options) {
    if (typeof options.write === 'function')
      this._write = options.write;

    if (typeof options.writev === 'function')
      this._writev = options.writev;
  }

  Stream.call(this);
}

// Otherwise people can pipe Writable streams, which is just wrong.
Writable.prototype.pipe = function() {
  this.emit('error', new Error('Cannot pipe. Not readable.'));
};


function writeAfterEnd(stream, cb) {
  var er = new Error('write after end');
  // TODO: defer error events consistently everywhere, not just the cb
  stream.emit('error', er);
  processNextTick(cb, er);
}

// If we get something that is not a buffer, string, null, or undefined,
// and we're not in objectMode, then that's an error.
// Otherwise stream chunks are all considered to be of length=1, and the
// watermarks determine how many objects to keep in the buffer, rather than
// how many bytes or characters.
function validChunk(stream, state, chunk, cb) {
  var valid = true;

  if (!(Buffer.isBuffer(chunk)) &&
      typeof chunk !== 'string' &&
      chunk !== null &&
      chunk !== undefined &&
      !state.objectMode) {
    var er = new TypeError('Invalid non-string/buffer chunk');
    stream.emit('error', er);
    processNextTick(cb, er);
    valid = false;
  }
  return valid;
}

Writable.prototype.write = function(chunk, encoding, cb) {
  var state = this._writableState;
  var ret = false;

  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (Buffer.isBuffer(chunk))
    encoding = 'buffer';
  else if (!encoding)
    encoding = state.defaultEncoding;

  if (typeof cb !== 'function')
    cb = nop;

  if (state.ended)
    writeAfterEnd(this, cb);
  else if (validChunk(this, state, chunk, cb)) {
    state.pendingcb++;
    ret = writeOrBuffer(this, state, chunk, encoding, cb);
  }

  return ret;
};

Writable.prototype.cork = function() {
  var state = this._writableState;

  state.corked++;
};

Writable.prototype.uncork = function() {
  var state = this._writableState;

  if (state.corked) {
    state.corked--;

    if (!state.writing &&
        !state.corked &&
        !state.finished &&
        !state.bufferProcessing &&
        state.bufferedRequest)
      clearBuffer(this, state);
  }
};

Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
  // node::ParseEncoding() requires lower case.
  if (typeof encoding === 'string')
    encoding = encoding.toLowerCase();
  if (!(['hex', 'utf8', 'utf-8', 'ascii', 'binary', 'base64',
'ucs2', 'ucs-2','utf16le', 'utf-16le', 'raw']
.indexOf((encoding + '').toLowerCase()) > -1))
    throw new TypeError('Unknown encoding: ' + encoding);
  this._writableState.defaultEncoding = encoding;
};

function decodeChunk(state, chunk, encoding) {
  if (!state.objectMode &&
      state.decodeStrings !== false &&
      typeof chunk === 'string') {
    chunk = new Buffer(chunk, encoding);
  }
  return chunk;
}

// if we're already writing something, then just put this
// in the queue, and wait our turn.  Otherwise, call _write
// If we return false, then we need a drain event, so set that flag.
function writeOrBuffer(stream, state, chunk, encoding, cb) {
  chunk = decodeChunk(state, chunk, encoding);

  if (Buffer.isBuffer(chunk))
    encoding = 'buffer';
  var len = state.objectMode ? 1 : chunk.length;

  state.length += len;

  var ret = state.length < state.highWaterMark;
  // we must ensure that previous needDrain will not be reset to false.
  if (!ret)
    state.needDrain = true;

  if (state.writing || state.corked) {
    var last = state.lastBufferedRequest;
    state.lastBufferedRequest = new WriteReq(chunk, encoding, cb);
    if (last) {
      last.next = state.lastBufferedRequest;
    } else {
      state.bufferedRequest = state.lastBufferedRequest;
    }
  } else {
    doWrite(stream, state, false, len, chunk, encoding, cb);
  }

  return ret;
}

function doWrite(stream, state, writev, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (writev)
    stream._writev(chunk, state.onwrite);
  else
    stream._write(chunk, encoding, state.onwrite);
  state.sync = false;
}

function onwriteError(stream, state, sync, er, cb) {
  --state.pendingcb;
  if (sync)
    processNextTick(cb, er);
  else
    cb(er);

  stream._writableState.errorEmitted = true;
  stream.emit('error', er);
}

function onwriteStateUpdate(state) {
  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;
}

function onwrite(stream, er) {
  var state = stream._writableState;
  var sync = state.sync;
  var cb = state.writecb;

  onwriteStateUpdate(state);

  if (er)
    onwriteError(stream, state, sync, er, cb);
  else {
    // Check if we're actually ready to finish, but don't emit yet
    var finished = needFinish(state);

    if (!finished &&
        !state.corked &&
        !state.bufferProcessing &&
        state.bufferedRequest) {
      clearBuffer(stream, state);
    }

    if (sync) {
      processNextTick(afterWrite, stream, state, finished, cb);
    } else {
      afterWrite(stream, state, finished, cb);
    }
  }
}

function afterWrite(stream, state, finished, cb) {
  if (!finished)
    onwriteDrain(stream, state);
  state.pendingcb--;
  cb();
  finishMaybe(stream, state);
}

// Must force callback to be called on nextTick, so that we don't
// emit 'drain' before the write() consumer gets the 'false' return
// value, and has a chance to attach a 'drain' listener.
function onwriteDrain(stream, state) {
  if (state.length === 0 && state.needDrain) {
    state.needDrain = false;
    stream.emit('drain');
  }
}


// if there's something in the buffer waiting, then process it
function clearBuffer(stream, state) {
  state.bufferProcessing = true;
  var entry = state.bufferedRequest;

  if (stream._writev && entry && entry.next) {
    // Fast case, write everything using _writev()
    var buffer = [];
    var cbs = [];
    while (entry) {
      cbs.push(entry.callback);
      buffer.push(entry);
      entry = entry.next;
    }

    // count the one we are adding, as well.
    // TODO(isaacs) clean this up
    state.pendingcb++;
    state.lastBufferedRequest = null;
    doWrite(stream, state, true, state.length, buffer, '', function(err) {
      for (var i = 0; i < cbs.length; i++) {
        state.pendingcb--;
        cbs[i](err);
      }
    });

    // Clear buffer
  } else {
    // Slow case, write chunks one-by-one
    while (entry) {
      var chunk = entry.chunk;
      var encoding = entry.encoding;
      var cb = entry.callback;
      var len = state.objectMode ? 1 : chunk.length;

      doWrite(stream, state, false, len, chunk, encoding, cb);
      entry = entry.next;
      // if we didn't call the onwrite immediately, then
      // it means that we need to wait until it does.
      // also, that means that the chunk and cb are currently
      // being processed, so move the buffer counter past them.
      if (state.writing) {
        break;
      }
    }

    if (entry === null)
      state.lastBufferedRequest = null;
  }
  state.bufferedRequest = entry;
  state.bufferProcessing = false;
}

Writable.prototype._write = function(chunk, encoding, cb) {
  cb(new Error('not implemented'));
};

Writable.prototype._writev = null;

Writable.prototype.end = function(chunk, encoding, cb) {
  var state = this._writableState;

  if (typeof chunk === 'function') {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (chunk !== null && chunk !== undefined)
    this.write(chunk, encoding);

  // .end() fully uncorks
  if (state.corked) {
    state.corked = 1;
    this.uncork();
  }

  // ignore unnecessary end() calls.
  if (!state.ending && !state.finished)
    endWritable(this, state, cb);
};


function needFinish(state) {
  return (state.ending &&
          state.length === 0 &&
          state.bufferedRequest === null &&
          !state.finished &&
          !state.writing);
}

function prefinish(stream, state) {
  if (!state.prefinished) {
    state.prefinished = true;
    stream.emit('prefinish');
  }
}

function finishMaybe(stream, state) {
  var need = needFinish(state);
  if (need) {
    if (state.pendingcb === 0) {
      prefinish(stream, state);
      state.finished = true;
      stream.emit('finish');
    } else {
      prefinish(stream, state);
    }
  }
  return need;
}

function endWritable(stream, state, cb) {
  state.ending = true;
  finishMaybe(stream, state);
  if (cb) {
    if (state.finished)
      processNextTick(cb);
    else
      stream.once('finish', cb);
  }
  state.ended = true;
}

},{"./_stream_duplex":49,"buffer":25,"core-util-is":54,"events":29,"inherits":101,"process-nextick-args":56,"util-deprecate":58}],54:[function(require,module,exports){
(function (Buffer){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.

function isArray(arg) {
  if (Array.isArray) {
    return Array.isArray(arg);
  }
  return objectToString(arg) === '[object Array]';
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = Buffer.isBuffer;

function objectToString(o) {
  return Object.prototype.toString.call(o);
}

}).call(this,{"isBuffer":require("../../../../../../../../browserify/node_modules/insert-module-globals/node_modules/is-buffer/index.js")})
},{"../../../../../../../../browserify/node_modules/insert-module-globals/node_modules/is-buffer/index.js":31}],55:[function(require,module,exports){
module.exports = Array.isArray || function (arr) {
  return Object.prototype.toString.call(arr) == '[object Array]';
};

},{}],56:[function(require,module,exports){
(function (process){
'use strict';

if (!process.version ||
    process.version.indexOf('v0.') === 0 ||
    process.version.indexOf('v1.') === 0 && process.version.indexOf('v1.8.') !== 0) {
  module.exports = nextTick;
} else {
  module.exports = process.nextTick;
}

function nextTick(fn) {
  var args = new Array(arguments.length - 1);
  var i = 0;
  while (i < args.length) {
    args[i++] = arguments[i];
  }
  process.nextTick(function afterTick() {
    fn.apply(null, args);
  });
}

}).call(this,require('_process'))
},{"_process":33}],57:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var Buffer = require('buffer').Buffer;

var isBufferEncoding = Buffer.isEncoding
  || function(encoding) {
       switch (encoding && encoding.toLowerCase()) {
         case 'hex': case 'utf8': case 'utf-8': case 'ascii': case 'binary': case 'base64': case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': case 'raw': return true;
         default: return false;
       }
     }


function assertEncoding(encoding) {
  if (encoding && !isBufferEncoding(encoding)) {
    throw new Error('Unknown encoding: ' + encoding);
  }
}

// StringDecoder provides an interface for efficiently splitting a series of
// buffers into a series of JS strings without breaking apart multi-byte
// characters. CESU-8 is handled as part of the UTF-8 encoding.
//
// @TODO Handling all encodings inside a single object makes it very difficult
// to reason about this code, so it should be split up in the future.
// @TODO There should be a utf8-strict encoding that rejects invalid UTF-8 code
// points as used by CESU-8.
var StringDecoder = exports.StringDecoder = function(encoding) {
  this.encoding = (encoding || 'utf8').toLowerCase().replace(/[-_]/, '');
  assertEncoding(encoding);
  switch (this.encoding) {
    case 'utf8':
      // CESU-8 represents each of Surrogate Pair by 3-bytes
      this.surrogateSize = 3;
      break;
    case 'ucs2':
    case 'utf16le':
      // UTF-16 represents each of Surrogate Pair by 2-bytes
      this.surrogateSize = 2;
      this.detectIncompleteChar = utf16DetectIncompleteChar;
      break;
    case 'base64':
      // Base-64 stores 3 bytes in 4 chars, and pads the remainder.
      this.surrogateSize = 3;
      this.detectIncompleteChar = base64DetectIncompleteChar;
      break;
    default:
      this.write = passThroughWrite;
      return;
  }

  // Enough space to store all bytes of a single character. UTF-8 needs 4
  // bytes, but CESU-8 may require up to 6 (3 bytes per surrogate).
  this.charBuffer = new Buffer(6);
  // Number of bytes received for the current incomplete multi-byte character.
  this.charReceived = 0;
  // Number of bytes expected for the current incomplete multi-byte character.
  this.charLength = 0;
};


// write decodes the given buffer and returns it as JS string that is
// guaranteed to not contain any partial multi-byte characters. Any partial
// character found at the end of the buffer is buffered up, and will be
// returned when calling write again with the remaining bytes.
//
// Note: Converting a Buffer containing an orphan surrogate to a String
// currently works, but converting a String to a Buffer (via `new Buffer`, or
// Buffer#write) will replace incomplete surrogates with the unicode
// replacement character. See https://codereview.chromium.org/121173009/ .
StringDecoder.prototype.write = function(buffer) {
  var charStr = '';
  // if our last write ended with an incomplete multibyte character
  while (this.charLength) {
    // determine how many remaining bytes this buffer has to offer for this char
    var available = (buffer.length >= this.charLength - this.charReceived) ?
        this.charLength - this.charReceived :
        buffer.length;

    // add the new bytes to the char buffer
    buffer.copy(this.charBuffer, this.charReceived, 0, available);
    this.charReceived += available;

    if (this.charReceived < this.charLength) {
      // still not enough chars in this buffer? wait for more ...
      return '';
    }

    // remove bytes belonging to the current character from the buffer
    buffer = buffer.slice(available, buffer.length);

    // get the character that was split
    charStr = this.charBuffer.slice(0, this.charLength).toString(this.encoding);

    // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
    var charCode = charStr.charCodeAt(charStr.length - 1);
    if (charCode >= 0xD800 && charCode <= 0xDBFF) {
      this.charLength += this.surrogateSize;
      charStr = '';
      continue;
    }
    this.charReceived = this.charLength = 0;

    // if there are no more bytes in this buffer, just emit our char
    if (buffer.length === 0) {
      return charStr;
    }
    break;
  }

  // determine and set charLength / charReceived
  this.detectIncompleteChar(buffer);

  var end = buffer.length;
  if (this.charLength) {
    // buffer the incomplete character bytes we got
    buffer.copy(this.charBuffer, 0, buffer.length - this.charReceived, end);
    end -= this.charReceived;
  }

  charStr += buffer.toString(this.encoding, 0, end);

  var end = charStr.length - 1;
  var charCode = charStr.charCodeAt(end);
  // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
  if (charCode >= 0xD800 && charCode <= 0xDBFF) {
    var size = this.surrogateSize;
    this.charLength += size;
    this.charReceived += size;
    this.charBuffer.copy(this.charBuffer, size, 0, size);
    buffer.copy(this.charBuffer, 0, 0, size);
    return charStr.substring(0, end);
  }

  // or just emit the charStr
  return charStr;
};

// detectIncompleteChar determines if there is an incomplete UTF-8 character at
// the end of the given buffer. If so, it sets this.charLength to the byte
// length that character, and sets this.charReceived to the number of bytes
// that are available for this character.
StringDecoder.prototype.detectIncompleteChar = function(buffer) {
  // determine how many bytes we have to check at the end of this buffer
  var i = (buffer.length >= 3) ? 3 : buffer.length;

  // Figure out if one of the last i bytes of our buffer announces an
  // incomplete char.
  for (; i > 0; i--) {
    var c = buffer[buffer.length - i];

    // See http://en.wikipedia.org/wiki/UTF-8#Description

    // 110XXXXX
    if (i == 1 && c >> 5 == 0x06) {
      this.charLength = 2;
      break;
    }

    // 1110XXXX
    if (i <= 2 && c >> 4 == 0x0E) {
      this.charLength = 3;
      break;
    }

    // 11110XXX
    if (i <= 3 && c >> 3 == 0x1E) {
      this.charLength = 4;
      break;
    }
  }
  this.charReceived = i;
};

StringDecoder.prototype.end = function(buffer) {
  var res = '';
  if (buffer && buffer.length)
    res = this.write(buffer);

  if (this.charReceived) {
    var cr = this.charReceived;
    var buf = this.charBuffer;
    var enc = this.encoding;
    res += buf.slice(0, cr).toString(enc);
  }

  return res;
};

function passThroughWrite(buffer) {
  return buffer.toString(this.encoding);
}

function utf16DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 2;
  this.charLength = this.charReceived ? 2 : 0;
}

function base64DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 3;
  this.charLength = this.charReceived ? 3 : 0;
}

},{"buffer":25}],58:[function(require,module,exports){
(function (global){

/**
 * Module exports.
 */

module.exports = deprecate;

/**
 * Mark that a method should not be used.
 * Returns a modified function which warns once by default.
 *
 * If `localStorage.noDeprecation = true` is set, then it is a no-op.
 *
 * If `localStorage.throwDeprecation = true` is set, then deprecated functions
 * will throw an Error when invoked.
 *
 * If `localStorage.traceDeprecation = true` is set, then deprecated functions
 * will invoke `console.trace()` instead of `console.error()`.
 *
 * @param {Function} fn - the function to deprecate
 * @param {String} msg - the string to print to the console when `fn` is invoked
 * @returns {Function} a new "deprecated" version of `fn`
 * @api public
 */

function deprecate (fn, msg) {
  if (config('noDeprecation')) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (config('throwDeprecation')) {
        throw new Error(msg);
      } else if (config('traceDeprecation')) {
        console.trace(msg);
      } else {
        console.warn(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
}

/**
 * Checks `localStorage` for boolean values for the given `name`.
 *
 * @param {String} name
 * @returns {Boolean}
 * @api private
 */

function config (name) {
  // accessing global.localStorage can trigger a DOMException in sandboxed iframes
  try {
    if (!global.localStorage) return false;
  } catch (_) {
    return false;
  }
  var val = global.localStorage[name];
  if (null == val) return false;
  return String(val).toLowerCase() === 'true';
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],59:[function(require,module,exports){
var Stream = (function (){
  try {
    return require('st' + 'ream'); // hack to fix a circular dependency issue when used with browserify
  } catch(_){}
}());
exports = module.exports = require('./lib/_stream_readable.js');
exports.Stream = Stream || exports;
exports.Readable = exports;
exports.Writable = require('./lib/_stream_writable.js');
exports.Duplex = require('./lib/_stream_duplex.js');
exports.Transform = require('./lib/_stream_transform.js');
exports.PassThrough = require('./lib/_stream_passthrough.js');

},{"./lib/_stream_duplex.js":49,"./lib/_stream_passthrough.js":50,"./lib/_stream_readable.js":51,"./lib/_stream_transform.js":52,"./lib/_stream_writable.js":53}],60:[function(require,module,exports){
module.exports = ChunkStoreWriteStream

var BlockStream = require('block-stream2')
var inherits = require('inherits')
var stream = require('stream')

inherits(ChunkStoreWriteStream, stream.Writable)

function ChunkStoreWriteStream (store, chunkLength, opts) {
  var self = this
  if (!(self instanceof ChunkStoreWriteStream)) {
    return new ChunkStoreWriteStream(store, chunkLength, opts)
  }
  stream.Writable.call(self, opts)
  if (!opts) opts = {}

  if (!store || !store.put || !store.get) {
    throw new Error('First argument must be an abstract-chunk-store compliant store')
  }
  chunkLength = Number(chunkLength)
  if (!chunkLength) throw new Error('Second argument must be a chunk length')

  self._blockstream = new BlockStream(chunkLength, { zeroPadding: false })

  self._blockstream
    .on('data', onData)
    .on('error', function (err) { self.destroy(err) })

  var index = 0
  function onData (chunk) {
    if (self.destroyed) return
    store.put(index, chunk)
    index += 1
  }

  self.on('finish', function () { this._blockstream.end() })
}

ChunkStoreWriteStream.prototype._write = function (chunk, encoding, callback) {
  this._blockstream.write(chunk, encoding, callback)
}

ChunkStoreWriteStream.prototype.destroy = function (err) {
  if (this.destroyed) return
  this.destroyed = true

  if (err) this.emit('error', err)
  this.emit('close')
}

},{"block-stream2":47,"inherits":101,"stream":38}],61:[function(require,module,exports){
(function (global,Buffer){
module.exports = createTorrent
module.exports.parseInput = parseInput

module.exports.announceList = [
  [ 'udp://tracker.openbittorrent.com:80' ],
  [ 'udp://tracker.internetwarriors.net:1337' ],
  [ 'udp://tracker.leechers-paradise.org:6969' ],
  [ 'udp://tracker.coppersurfer.tk:6969' ],
  [ 'udp://exodus.desync.com:6969' ],
  [ 'wss://tracker.webtorrent.io' ], // For WebRTC peers (see: WebTorrent.io)
  [ 'wss://tracker.btorrent.xyz' ] // For WebRTC peers (see: btorrent.xyz)
]

var bencode = require('bencode')
var BlockStream = require('block-stream2')
var calcPieceLength = require('piece-length')
var corePath = require('path')
var dezalgo = require('dezalgo')
var FileReadStream = require('filestream/read')
var flatten = require('flatten')
var fs = require('fs')
var isFile = require('is-file')
var junk = require('junk')
var MultiStream = require('multistream')
var once = require('once')
var parallel = require('run-parallel')
var sha1 = require('simple-sha1')
var stream = require('stream')

/**
 * Create a torrent.
 * @param  {string|File|FileList|Buffer|Stream|Array.<string|File|Buffer|Stream>} input
 * @param  {Object} opts
 * @param  {string=} opts.name
 * @param  {Date=} opts.creationDate
 * @param  {string=} opts.comment
 * @param  {string=} opts.createdBy
 * @param  {boolean|number=} opts.private
 * @param  {number=} opts.pieceLength
 * @param  {Array.<Array.<string>>=} opts.announceList
 * @param  {Array.<string>=} opts.urlList
 * @param  {function} cb
 * @return {Buffer} buffer of .torrent file data
 */
function createTorrent (input, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (!opts) opts = {}
  parseInput(input, opts, function (err, files, singleFileTorrent) {
    if (err) return cb(err)
    opts.singleFileTorrent = singleFileTorrent
    onFiles(files, opts, cb)
  })
}

function parseInput (input, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (!opts) opts = {}
  cb = dezalgo(cb)

  if (Array.isArray(input) && input.length === 0) throw new Error('invalid input type')

  if (isFileList(input)) input = Array.prototype.slice.call(input)
  if (!Array.isArray(input)) input = [ input ]

  // In Electron, use the true file path
  input = input.map(function (item) {
    if (isBlob(item) && typeof item.path === 'string') return item.path
    return item
  })

  // If there's just one file, allow the name to be set by `opts.name`
  if (input.length === 1 && typeof input[0] !== 'string' && !input[0].name) input[0].name = opts.name

  var commonPrefix = null
  input.forEach(function (item, i) {
    if (typeof item === 'string') return

    var path = item.fullPath || item.name
    if (!path) throw new Error('missing required `fullPath` or `name` property on input')

    item.path = path.split('/')

    if (!item.path[0]) item.path.shift() // Remove initial slash

    if (item.path.length < 2) { // No real prefix
      commonPrefix = null
    } else if (i === 0 && input.length > 1) { // The first file has a prefix
      commonPrefix = item.path[0]
    } else if (item.path[0] !== commonPrefix) { // The prefix doesn't match
      commonPrefix = null
    }
  })

  // remove junk files
  input = input.filter(function (item) {
    if (typeof item === 'string') return true
    var filename = item.path[item.path.length - 1]
    return notHidden(filename) && junk.not(filename)
  })

  if (commonPrefix) {
    input.forEach(function (item) {
      if (typeof item === 'string') return
      item.path.shift()
    })
  }

  if (!opts.name && commonPrefix) opts.name = commonPrefix
  if (!opts.name && input[0] && input[0].name) opts.name = input[0].name
  if (!opts.name && typeof input[0] === 'string') opts.name = corePath.basename(input[0])

  if (opts.name === undefined) {
    throw new Error('missing option \'name\' and unable to infer it from input[0].name')
  }

  var numPaths = input.reduce(function (sum, item) {
    return sum + Number(typeof item === 'string')
  }, 0)

  var isSingleFileTorrent = (input.length === 1)

  if (input.length === 1 && typeof input[0] === 'string') {
    if (typeof fs.stat !== 'function') {
      throw new Error('filesystem paths do not work in the browser')
    }
    // If there's a single path, verify it's a file before deciding this is a single
    // file torrent
    isFile(input[0], function (err, pathIsFile) {
      if (err) return cb(err)
      isSingleFileTorrent = pathIsFile
      processInput()
    })
  } else {
    processInput()
  }

  function processInput () {
    parallel(input.map(function (item) {
      return function (cb) {
        var file = {}

        if (isBlob(item)) {
          file.getStream = getBlobStream(item)
          file.length = item.size
        } else if (Buffer.isBuffer(item)) {
          file.getStream = getBufferStream(item)
          file.length = item.length
        } else if (isReadable(item)) {
          if (!opts.pieceLength) {
            throw new Error('must specify `pieceLength` option if input is Stream')
          }
          file.getStream = getStreamStream(item, file)
          file.length = 0
        } else if (typeof item === 'string') {
          if (typeof fs.stat !== 'function') {
            throw new Error('filesystem paths do not work in the browser')
          }
          var keepRoot = numPaths > 1 || isSingleFileTorrent
          getFiles(item, keepRoot, cb)
          return // early return!
        } else {
          throw new Error('invalid input type')
        }
        file.path = item.path
        cb(null, file)
      }
    }), function (err, files) {
      if (err) return cb(err)
      files = flatten(files)
      cb(null, files, isSingleFileTorrent)
    })
  }
}

function getFiles (path, keepRoot, cb) {
  traversePath(path, getFileInfo, function (err, files) {
    if (err) return cb(err)

    if (Array.isArray(files)) files = flatten(files)
    else files = [ files ]

    path = corePath.normalize(path)
    if (keepRoot) {
      path = path.slice(0, path.lastIndexOf(corePath.sep) + 1)
    }
    if (path[path.length - 1] !== corePath.sep) path += corePath.sep

    files.forEach(function (file) {
      file.getStream = getFilePathStream(file.path)
      file.path = file.path.replace(path, '').split(corePath.sep)
    })
    cb(null, files)
  })
}

function getFileInfo (path, cb) {
  cb = once(cb)
  fs.stat(path, function (err, stat) {
    if (err) return cb(err)
    var info = {
      length: stat.size,
      path: path
    }
    cb(null, info)
  })
}

function traversePath (path, fn, cb) {
  fs.readdir(path, function (err, entries) {
    if (err && err.code === 'ENOTDIR') {
      // this is a file
      fn(path, cb)
    } else if (err) {
      // real error
      cb(err)
    } else {
      // this is a folder
      parallel(entries.filter(notHidden).filter(junk.not).map(function (entry) {
        return function (cb) {
          traversePath(corePath.join(path, entry), fn, cb)
        }
      }), cb)
    }
  })
}

function notHidden (file) {
  return file[0] !== '.'
}

function getPieceList (files, pieceLength, cb) {
  cb = once(cb)
  var pieces = []
  var length = 0

  var streams = files.map(function (file) {
    return file.getStream
  })

  var remainingHashes = 0
  var pieceNum = 0
  var ended = false

  var multistream = new MultiStream(streams)
  var blockstream = new BlockStream(pieceLength, { zeroPadding: false })

  multistream.on('error', onError)

  multistream
    .pipe(blockstream)
    .on('data', onData)
    .on('end', onEnd)
    .on('error', onError)

  function onData (chunk) {
    length += chunk.length

    var i = pieceNum
    sha1(chunk, function (hash) {
      pieces[i] = hash
      remainingHashes -= 1
      maybeDone()
    })
    remainingHashes += 1
    pieceNum += 1
  }

  function onEnd () {
    ended = true
    maybeDone()
  }

  function onError (err) {
    cleanup()
    cb(err)
  }

  function cleanup () {
    multistream.removeListener('error', onError)
    blockstream.removeListener('data', onData)
    blockstream.removeListener('end', onEnd)
    blockstream.removeListener('error', onError)
  }

  function maybeDone () {
    if (ended && remainingHashes === 0) {
      cleanup()
      cb(null, new Buffer(pieces.join(''), 'hex'), length)
    }
  }
}

function onFiles (files, opts, cb) {
  var announceList = opts.announceList

  if (!announceList) {
    if (typeof opts.announce === 'string') announceList = [ [ opts.announce ] ]
    else if (Array.isArray(opts.announce)) {
      announceList = opts.announce.map(function (u) { return [ u ] })
    }
  }

  if (!announceList) announceList = []

  if (global.WEBTORRENT_ANNOUNCE) {
    if (typeof global.WEBTORRENT_ANNOUNCE === 'string') {
      announceList.push([ [ global.WEBTORRENT_ANNOUNCE ] ])
    } else if (Array.isArray(global.WEBTORRENT_ANNOUNCE)) {
      announceList = announceList.concat(global.WEBTORRENT_ANNOUNCE.map(function (u) {
        return [ u ]
      }))
    }
  }

  // When no trackers specified, use some reasonable defaults
  if (opts.announce === undefined && opts.announceList === undefined) {
    announceList = announceList.concat(module.exports.announceList)
  }

  if (typeof opts.urlList === 'string') opts.urlList = [ opts.urlList ]

  var torrent = {
    info: {
      name: opts.name
    },
    'creation date': Number(opts.creationDate) || Date.now(),
    encoding: 'UTF-8'
  }

  if (announceList.length !== 0) {
    torrent.announce = announceList[0][0]
    torrent['announce-list'] = announceList
  }

  if (opts.comment !== undefined) torrent.comment = opts.comment

  if (opts.createdBy !== undefined) torrent['created by'] = opts.createdBy

  if (opts.private !== undefined) torrent.info.private = Number(opts.private)

  // "ssl-cert" key is for SSL torrents, see:
  //   - http://blog.libtorrent.org/2012/01/bittorrent-over-ssl/
  //   - http://www.libtorrent.org/manual-ref.html#ssl-torrents
  //   - http://www.libtorrent.org/reference-Create_Torrents.html
  if (opts.sslCert !== undefined) torrent.info['ssl-cert'] = opts.sslCert

  if (opts.urlList !== undefined) torrent['url-list'] = opts.urlList

  var pieceLength = opts.pieceLength || calcPieceLength(files.reduce(sumLength, 0))
  torrent.info['piece length'] = pieceLength

  getPieceList(files, pieceLength, function (err, pieces, torrentLength) {
    if (err) return cb(err)
    torrent.info.pieces = pieces

    files.forEach(function (file) {
      delete file.getStream
    })

    if (opts.singleFileTorrent) {
      torrent.info.length = torrentLength
    } else {
      torrent.info.files = files
    }

    cb(null, bencode.encode(torrent))
  })
}

/**
 * Accumulator to sum file lengths
 * @param  {number} sum
 * @param  {Object} file
 * @return {number}
 */
function sumLength (sum, file) {
  return sum + file.length
}

/**
 * Check if `obj` is a W3C `Blob` object (which `File` inherits from)
 * @param  {*} obj
 * @return {boolean}
 */
function isBlob (obj) {
  return typeof Blob !== 'undefined' && obj instanceof Blob
}

/**
 * Check if `obj` is a W3C `FileList` object
 * @param  {*} obj
 * @return {boolean}
 */
function isFileList (obj) {
  return typeof FileList === 'function' && obj instanceof FileList
}

/**
 * Check if `obj` is a node Readable stream
 * @param  {*} obj
 * @return {boolean}
 */
function isReadable (obj) {
  return typeof obj === 'object' && obj != null && typeof obj.pipe === 'function'
}

/**
 * Convert a `File` to a lazy readable stream.
 * @param  {File|Blob} file
 * @return {function}
 */
function getBlobStream (file) {
  return function () {
    return new FileReadStream(file)
  }
}

/**
 * Convert a `Buffer` to a lazy readable stream.
 * @param  {Buffer} buffer
 * @return {function}
 */
function getBufferStream (buffer) {
  return function () {
    var s = new stream.PassThrough()
    s.end(buffer)
    return s
  }
}

/**
 * Convert a file path to a lazy readable stream.
 * @param  {string} path
 * @return {function}
 */
function getFilePathStream (path) {
  return function () {
    return fs.createReadStream(path)
  }
}

/**
 * Convert a readable stream to a lazy readable stream. Adds instrumentation to track
 * the number of bytes in the stream and set `file.length`.
 *
 * @param  {Stream} stream
 * @param  {Object} file
 * @return {function}
 */
function getStreamStream (readable, file) {
  return function () {
    var counter = new stream.Transform()
    counter._transform = function (buf, enc, done) {
      file.length += buf.length
      this.push(buf)
      done()
    }
    readable.pipe(counter)
    return counter
  }
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},require("buffer").Buffer)
},{"bencode":62,"block-stream2":66,"buffer":25,"dezalgo":79,"filestream/read":85,"flatten":86,"fs":23,"is-file":87,"junk":88,"multistream":104,"once":90,"path":32,"piece-length":91,"run-parallel":139,"simple-sha1":147,"stream":38}],62:[function(require,module,exports){
module.exports = {
  encode: require( './lib/encode' ),
  decode: require( './lib/decode' )
}

},{"./lib/decode":63,"./lib/encode":65}],63:[function(require,module,exports){
(function (Buffer){
var Dict = require("./dict")

/**
 * Decodes bencoded data.
 *
 * @param  {Buffer} data
 * @param  {String} encoding
 * @return {Object|Array|Buffer|String|Number}
 */
function decode( data, encoding ) {

  decode.position = 0
  decode.encoding = encoding || null

  decode.data = !( Buffer.isBuffer(data) )
    ? new Buffer( data )
    : data

  return decode.next()

}

decode.position = 0
decode.data     = null
decode.encoding = null

decode.next = function() {

  switch( decode.data[decode.position] ) {
    case 0x64: return decode.dictionary(); break
    case 0x6C: return decode.list(); break
    case 0x69: return decode.integer(); break
    default:   return decode.bytes(); break
  }

}

decode.find = function( chr ) {

  var i = decode.position
  var c = decode.data.length
  var d = decode.data

  while( i < c ) {
    if( d[i] === chr )
      return i
    i++
  }

  throw new Error(
    'Invalid data: Missing delimiter "' +
    String.fromCharCode( chr ) + '" [0x' +
    chr.toString( 16 ) + ']'
  )

}

decode.dictionary = function() {

  decode.position++

  var dict = new Dict()

  while( decode.data[decode.position] !== 0x65 ) {
    dict.binarySet(decode.bytes(), decode.next())
  }

  decode.position++

  return dict

}

decode.list = function() {

  decode.position++

  var lst = []

  while( decode.data[decode.position] !== 0x65 ) {
    lst.push( decode.next() )
  }

  decode.position++

  return lst

}

decode.integer = function() {

  var end    = decode.find( 0x65 )
  var number = decode.data.toString( 'ascii', decode.position + 1, end )

  decode.position += end + 1 - decode.position

  return parseInt( number, 10 )

}

decode.bytes = function() {

  var sep    = decode.find( 0x3A )
  var length = parseInt( decode.data.toString( 'ascii', decode.position, sep ), 10 )
  var end    = ++sep + length

  decode.position = end

  return decode.encoding
    ? decode.data.toString( decode.encoding, sep, end )
    : decode.data.slice( sep, end )

}

// Exports
module.exports = decode

}).call(this,require("buffer").Buffer)
},{"./dict":64,"buffer":25}],64:[function(require,module,exports){
arguments[4][14][0].apply(exports,arguments)
},{"dup":14}],65:[function(require,module,exports){
(function (Buffer){
/**
 * Encodes data in bencode.
 *
 * @param  {Buffer|Array|String|Object|Number} data
 * @return {Buffer}
 */
function encode( data ) {
  var buffers = []
  encode._encode( buffers, data )
  return Buffer.concat( buffers )
}

encode._floatConversionDetected = false

encode._encode = function( buffers, data ) {

  if( Buffer.isBuffer(data) ) {
    buffers.push(new Buffer(data.length + ':'))
    buffers.push(data)
    return;
  }

  switch( typeof data ) {
    case 'string':
      encode.bytes( buffers, data )
      break
    case 'number':
      encode.number( buffers, data )
      break
    case 'object':
      data.constructor === Array
        ? encode.list( buffers, data )
        : encode.dict( buffers, data )
      break
  }

}

var buff_e = new Buffer('e')
  , buff_d = new Buffer('d')
  , buff_l = new Buffer('l')

encode.bytes = function( buffers, data ) {

  buffers.push( new Buffer(Buffer.byteLength( data ) + ':' + data) )
}

encode.number = function( buffers, data ) {
  var maxLo = 0x80000000
  var hi = ( data / maxLo ) << 0
  var lo = ( data % maxLo  ) << 0
  var val = hi * maxLo + lo

  buffers.push( new Buffer( 'i' + val + 'e' ))

  if( val !== data && !encode._floatConversionDetected ) {
    encode._floatConversionDetected = true
    console.warn(
      'WARNING: Possible data corruption detected with value "'+data+'":',
      'Bencoding only defines support for integers, value was converted to "'+val+'"'
    )
    console.trace()
  }

}

encode.dict = function( buffers, data ) {

  buffers.push( buff_d )

  var j = 0
  var k
  // fix for issue #13 - sorted dicts
  var keys = Object.keys( data ).sort()
  var kl = keys.length

  for( ; j < kl ; j++) {
    k=keys[j]
    encode.bytes( buffers, k )
    encode._encode( buffers, data[k] )
  }

  buffers.push( buff_e )
}

encode.list = function( buffers, data ) {

  var i = 0, j = 1
  var c = data.length
  buffers.push( buff_l )

  for( ; i < c; i++ ) {
    encode._encode( buffers, data[i] )
  }

  buffers.push( buff_e )

}

// Expose
module.exports = encode

}).call(this,require("buffer").Buffer)
},{"buffer":25}],66:[function(require,module,exports){
arguments[4][47][0].apply(exports,arguments)
},{"buffer":25,"defined":67,"dup":47,"inherits":101,"readable-stream":78}],67:[function(require,module,exports){
arguments[4][48][0].apply(exports,arguments)
},{"dup":48}],68:[function(require,module,exports){
arguments[4][49][0].apply(exports,arguments)
},{"./_stream_readable":70,"./_stream_writable":72,"core-util-is":73,"dup":49,"inherits":101,"process-nextick-args":75}],69:[function(require,module,exports){
arguments[4][50][0].apply(exports,arguments)
},{"./_stream_transform":71,"core-util-is":73,"dup":50,"inherits":101}],70:[function(require,module,exports){
arguments[4][51][0].apply(exports,arguments)
},{"./_stream_duplex":68,"_process":33,"buffer":25,"core-util-is":73,"dup":51,"events":29,"inherits":101,"isarray":74,"process-nextick-args":75,"string_decoder/":76,"util":24}],71:[function(require,module,exports){
arguments[4][52][0].apply(exports,arguments)
},{"./_stream_duplex":68,"core-util-is":73,"dup":52,"inherits":101}],72:[function(require,module,exports){
arguments[4][53][0].apply(exports,arguments)
},{"./_stream_duplex":68,"buffer":25,"core-util-is":73,"dup":53,"events":29,"inherits":101,"process-nextick-args":75,"util-deprecate":77}],73:[function(require,module,exports){
arguments[4][54][0].apply(exports,arguments)
},{"../../../../../../../../browserify/node_modules/insert-module-globals/node_modules/is-buffer/index.js":31,"dup":54}],74:[function(require,module,exports){
arguments[4][55][0].apply(exports,arguments)
},{"dup":55}],75:[function(require,module,exports){
arguments[4][56][0].apply(exports,arguments)
},{"_process":33,"dup":56}],76:[function(require,module,exports){
arguments[4][57][0].apply(exports,arguments)
},{"buffer":25,"dup":57}],77:[function(require,module,exports){
arguments[4][58][0].apply(exports,arguments)
},{"dup":58}],78:[function(require,module,exports){
arguments[4][59][0].apply(exports,arguments)
},{"./lib/_stream_duplex.js":68,"./lib/_stream_passthrough.js":69,"./lib/_stream_readable.js":70,"./lib/_stream_transform.js":71,"./lib/_stream_writable.js":72,"dup":59}],79:[function(require,module,exports){
var wrappy = require('wrappy')
module.exports = wrappy(dezalgo)

var asap = require('asap')

function dezalgo (cb) {
  var sync = true
  asap(function () {
    sync = false
  })

  return function zalgoSafe() {
    var args = arguments
    var me = this
    if (sync)
      asap(function() {
        cb.apply(me, args)
      })
    else
      cb.apply(me, args)
  }
}

},{"asap":80,"wrappy":82}],80:[function(require,module,exports){
"use strict";

// rawAsap provides everything we need except exception management.
var rawAsap = require("./raw");
// RawTasks are recycled to reduce GC churn.
var freeTasks = [];
// We queue errors to ensure they are thrown in right order (FIFO).
// Array-as-queue is good enough here, since we are just dealing with exceptions.
var pendingErrors = [];
var requestErrorThrow = rawAsap.makeRequestCallFromTimer(throwFirstError);

function throwFirstError() {
    if (pendingErrors.length) {
        throw pendingErrors.shift();
    }
}

/**
 * Calls a task as soon as possible after returning, in its own event, with priority
 * over other events like animation, reflow, and repaint. An error thrown from an
 * event will not interrupt, nor even substantially slow down the processing of
 * other events, but will be rather postponed to a lower priority event.
 * @param {{call}} task A callable object, typically a function that takes no
 * arguments.
 */
module.exports = asap;
function asap(task) {
    var rawTask;
    if (freeTasks.length) {
        rawTask = freeTasks.pop();
    } else {
        rawTask = new RawTask();
    }
    rawTask.task = task;
    rawAsap(rawTask);
}

// We wrap tasks with recyclable task objects.  A task object implements
// `call`, just like a function.
function RawTask() {
    this.task = null;
}

// The sole purpose of wrapping the task is to catch the exception and recycle
// the task object after its single use.
RawTask.prototype.call = function () {
    try {
        this.task.call();
    } catch (error) {
        if (asap.onerror) {
            // This hook exists purely for testing purposes.
            // Its name will be periodically randomized to break any code that
            // depends on its existence.
            asap.onerror(error);
        } else {
            // In a web browser, exceptions are not fatal. However, to avoid
            // slowing down the queue of pending tasks, we rethrow the error in a
            // lower priority turn.
            pendingErrors.push(error);
            requestErrorThrow();
        }
    } finally {
        this.task = null;
        freeTasks[freeTasks.length] = this;
    }
};

},{"./raw":81}],81:[function(require,module,exports){
(function (global){
"use strict";

// Use the fastest means possible to execute a task in its own turn, with
// priority over other events including IO, animation, reflow, and redraw
// events in browsers.
//
// An exception thrown by a task will permanently interrupt the processing of
// subsequent tasks. The higher level `asap` function ensures that if an
// exception is thrown by a task, that the task queue will continue flushing as
// soon as possible, but if you use `rawAsap` directly, you are responsible to
// either ensure that no exceptions are thrown from your task, or to manually
// call `rawAsap.requestFlush` if an exception is thrown.
module.exports = rawAsap;
function rawAsap(task) {
    if (!queue.length) {
        requestFlush();
        flushing = true;
    }
    // Equivalent to push, but avoids a function call.
    queue[queue.length] = task;
}

var queue = [];
// Once a flush has been requested, no further calls to `requestFlush` are
// necessary until the next `flush` completes.
var flushing = false;
// `requestFlush` is an implementation-specific method that attempts to kick
// off a `flush` event as quickly as possible. `flush` will attempt to exhaust
// the event queue before yielding to the browser's own event loop.
var requestFlush;
// The position of the next task to execute in the task queue. This is
// preserved between calls to `flush` so that it can be resumed if
// a task throws an exception.
var index = 0;
// If a task schedules additional tasks recursively, the task queue can grow
// unbounded. To prevent memory exhaustion, the task queue will periodically
// truncate already-completed tasks.
var capacity = 1024;

// The flush function processes all tasks that have been scheduled with
// `rawAsap` unless and until one of those tasks throws an exception.
// If a task throws an exception, `flush` ensures that its state will remain
// consistent and will resume where it left off when called again.
// However, `flush` does not make any arrangements to be called again if an
// exception is thrown.
function flush() {
    while (index < queue.length) {
        var currentIndex = index;
        // Advance the index before calling the task. This ensures that we will
        // begin flushing on the next task the task throws an error.
        index = index + 1;
        queue[currentIndex].call();
        // Prevent leaking memory for long chains of recursive calls to `asap`.
        // If we call `asap` within tasks scheduled by `asap`, the queue will
        // grow, but to avoid an O(n) walk for every task we execute, we don't
        // shift tasks off the queue after they have been executed.
        // Instead, we periodically shift 1024 tasks off the queue.
        if (index > capacity) {
            // Manually shift all values starting at the index back to the
            // beginning of the queue.
            for (var scan = 0, newLength = queue.length - index; scan < newLength; scan++) {
                queue[scan] = queue[scan + index];
            }
            queue.length -= index;
            index = 0;
        }
    }
    queue.length = 0;
    index = 0;
    flushing = false;
}

// `requestFlush` is implemented using a strategy based on data collected from
// every available SauceLabs Selenium web driver worker at time of writing.
// https://docs.google.com/spreadsheets/d/1mG-5UYGup5qxGdEMWkhP6BWCz053NUb2E1QoUTU16uA/edit#gid=783724593

// Safari 6 and 6.1 for desktop, iPad, and iPhone are the only browsers that
// have WebKitMutationObserver but not un-prefixed MutationObserver.
// Must use `global` instead of `window` to work in both frames and web
// workers. `global` is a provision of Browserify, Mr, Mrs, or Mop.
var BrowserMutationObserver = global.MutationObserver || global.WebKitMutationObserver;

// MutationObservers are desirable because they have high priority and work
// reliably everywhere they are implemented.
// They are implemented in all modern browsers.
//
// - Android 4-4.3
// - Chrome 26-34
// - Firefox 14-29
// - Internet Explorer 11
// - iPad Safari 6-7.1
// - iPhone Safari 7-7.1
// - Safari 6-7
if (typeof BrowserMutationObserver === "function") {
    requestFlush = makeRequestCallFromMutationObserver(flush);

// MessageChannels are desirable because they give direct access to the HTML
// task queue, are implemented in Internet Explorer 10, Safari 5.0-1, and Opera
// 11-12, and in web workers in many engines.
// Although message channels yield to any queued rendering and IO tasks, they
// would be better than imposing the 4ms delay of timers.
// However, they do not work reliably in Internet Explorer or Safari.

// Internet Explorer 10 is the only browser that has setImmediate but does
// not have MutationObservers.
// Although setImmediate yields to the browser's renderer, it would be
// preferrable to falling back to setTimeout since it does not have
// the minimum 4ms penalty.
// Unfortunately there appears to be a bug in Internet Explorer 10 Mobile (and
// Desktop to a lesser extent) that renders both setImmediate and
// MessageChannel useless for the purposes of ASAP.
// https://github.com/kriskowal/q/issues/396

// Timers are implemented universally.
// We fall back to timers in workers in most engines, and in foreground
// contexts in the following browsers.
// However, note that even this simple case requires nuances to operate in a
// broad spectrum of browsers.
//
// - Firefox 3-13
// - Internet Explorer 6-9
// - iPad Safari 4.3
// - Lynx 2.8.7
} else {
    requestFlush = makeRequestCallFromTimer(flush);
}

// `requestFlush` requests that the high priority event queue be flushed as
// soon as possible.
// This is useful to prevent an error thrown in a task from stalling the event
// queue if the exception handled by Node.js’s
// `process.on("uncaughtException")` or by a domain.
rawAsap.requestFlush = requestFlush;

// To request a high priority event, we induce a mutation observer by toggling
// the text of a text node between "1" and "-1".
function makeRequestCallFromMutationObserver(callback) {
    var toggle = 1;
    var observer = new BrowserMutationObserver(callback);
    var node = document.createTextNode("");
    observer.observe(node, {characterData: true});
    return function requestCall() {
        toggle = -toggle;
        node.data = toggle;
    };
}

// The message channel technique was discovered by Malte Ubl and was the
// original foundation for this library.
// http://www.nonblocking.io/2011/06/windownexttick.html

// Safari 6.0.5 (at least) intermittently fails to create message ports on a
// page's first load. Thankfully, this version of Safari supports
// MutationObservers, so we don't need to fall back in that case.

// function makeRequestCallFromMessageChannel(callback) {
//     var channel = new MessageChannel();
//     channel.port1.onmessage = callback;
//     return function requestCall() {
//         channel.port2.postMessage(0);
//     };
// }

// For reasons explained above, we are also unable to use `setImmediate`
// under any circumstances.
// Even if we were, there is another bug in Internet Explorer 10.
// It is not sufficient to assign `setImmediate` to `requestFlush` because
// `setImmediate` must be called *by name* and therefore must be wrapped in a
// closure.
// Never forget.

// function makeRequestCallFromSetImmediate(callback) {
//     return function requestCall() {
//         setImmediate(callback);
//     };
// }

// Safari 6.0 has a problem where timers will get lost while the user is
// scrolling. This problem does not impact ASAP because Safari 6.0 supports
// mutation observers, so that implementation is used instead.
// However, if we ever elect to use timers in Safari, the prevalent work-around
// is to add a scroll event listener that calls for a flush.

// `setTimeout` does not call the passed callback if the delay is less than
// approximately 7 in web workers in Firefox 8 through 18, and sometimes not
// even then.

function makeRequestCallFromTimer(callback) {
    return function requestCall() {
        // We dispatch a timeout with a specified delay of 0 for engines that
        // can reliably accommodate that request. This will usually be snapped
        // to a 4 milisecond delay, but once we're flushing, there's no delay
        // between events.
        var timeoutHandle = setTimeout(handleTimer, 0);
        // However, since this timer gets frequently dropped in Firefox
        // workers, we enlist an interval handle that will try to fire
        // an event 20 times per second until it succeeds.
        var intervalHandle = setInterval(handleTimer, 50);

        function handleTimer() {
            // Whichever timer succeeds will cancel both timers and
            // execute the callback.
            clearTimeout(timeoutHandle);
            clearInterval(intervalHandle);
            callback();
        }
    };
}

// This is for `asap.js` only.
// Its name will be periodically randomized to break any code that depends on
// its existence.
rawAsap.makeRequestCallFromTimer = makeRequestCallFromTimer;

// ASAP was originally a nextTick shim included in Q. This was factored out
// into this ASAP package. It was later adapted to RSVP which made further
// amendments. These decisions, particularly to marginalize MessageChannel and
// to capture the MutationObserver implementation in a closure, were integrated
// back into ASAP proper.
// https://github.com/tildeio/rsvp.js/blob/cddf7232546a9cf858524b75cde6f9edf72620a7/lib/rsvp/asap.js

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],82:[function(require,module,exports){
arguments[4][20][0].apply(exports,arguments)
},{"dup":20}],83:[function(require,module,exports){
(function (Buffer){
/**
 * Convert a typed array to a Buffer without a copy
 *
 * Author:   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * License:  MIT
 *
 * `npm install typedarray-to-buffer`
 */

var isTypedArray = require('is-typedarray').strict

module.exports = function (arr) {
  // If `Buffer` is the browser `buffer` module, and the browser supports typed arrays,
  // then avoid a copy. Otherwise, create a `Buffer` with a copy.
  var constructor = Buffer.TYPED_ARRAY_SUPPORT
    ? Buffer._augment
    : function (arr) { return new Buffer(arr) }

  if (arr instanceof Uint8Array) {
    return constructor(arr)
  } else if (arr instanceof ArrayBuffer) {
    return constructor(new Uint8Array(arr))
  } else if (isTypedArray(arr)) {
    // Use the typed array's underlying ArrayBuffer to back new Buffer. This respects
    // the "view" on the ArrayBuffer, i.e. byteOffset and byteLength. No copy.
    return constructor(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength))
  } else {
    // Unsupported type, just pass it through to the `Buffer` constructor.
    return new Buffer(arr)
  }
}

}).call(this,require("buffer").Buffer)
},{"buffer":25,"is-typedarray":84}],84:[function(require,module,exports){
module.exports      = isTypedArray
isTypedArray.strict = isStrictTypedArray
isTypedArray.loose  = isLooseTypedArray

var toString = Object.prototype.toString
var names = {
    '[object Int8Array]': true
  , '[object Int16Array]': true
  , '[object Int32Array]': true
  , '[object Uint8Array]': true
  , '[object Uint8ClampedArray]': true
  , '[object Uint16Array]': true
  , '[object Uint32Array]': true
  , '[object Float32Array]': true
  , '[object Float64Array]': true
}

function isTypedArray(arr) {
  return (
       isStrictTypedArray(arr)
    || isLooseTypedArray(arr)
  )
}

function isStrictTypedArray(arr) {
  return (
       arr instanceof Int8Array
    || arr instanceof Int16Array
    || arr instanceof Int32Array
    || arr instanceof Uint8Array
    || arr instanceof Uint8ClampedArray
    || arr instanceof Uint16Array
    || arr instanceof Uint32Array
    || arr instanceof Float32Array
    || arr instanceof Float64Array
  )
}

function isLooseTypedArray(arr) {
  return names[toString.call(arr)]
}

},{}],85:[function(require,module,exports){
var Readable = require('stream').Readable;
var inherits = require('inherits');
var reExtension = /^.*\.(\w+)$/;
var toBuffer = require('typedarray-to-buffer');

function FileReadStream(file, opts) {
  var readStream = this;
  if (! (this instanceof FileReadStream)) {
    return new FileReadStream(file, opts);
  }
  opts = opts || {};

  // inherit readable
  Readable.call(this, opts);

  // save the read offset
  this._offset = 0;
  this._ready = false;
  this._file = file;
  this._size = file.size;
  this._chunkSize = opts.chunkSize || Math.max(this._size / 1000, 200 * 1024);

  // create the reader
  this.reader = new FileReader();

  // generate the header blocks that we will send as part of the initial payload
  this._generateHeaderBlocks(file, opts, function(err, blocks) {
    // if we encountered an error, emit it
    if (err) {
      return readStream.emit('error', err);
    }

    // push the header blocks out to the stream
    if (Array.isArray(blocks)) {
      blocks.forEach(function (block) {
        readStream.push(block);
      });
    }

    readStream._ready = true;
    readStream.emit('_ready');
  });
}

inherits(FileReadStream, Readable);
module.exports = FileReadStream;

FileReadStream.prototype._generateHeaderBlocks = function(file, opts, callback) {
  callback(null, []);
};

FileReadStream.prototype._read = function() {
  if (!this._ready) {
    this.once('_ready', this._read.bind(this));
    return;
  }
  var readStream = this;
  var reader = this.reader;

  var startOffset = this._offset;
  var endOffset = this._offset + this._chunkSize;
  if (endOffset > this._size) endOffset = this._size;

  if (startOffset === this._size) {
    this.destroy();
    this.push(null);
    return;
  }

  reader.onload = function() {
    // update the stream offset
    readStream._offset = endOffset;

    // get the data chunk
    readStream.push(toBuffer(reader.result));
  }
  reader.onerror = function() {
    readStream.emit('error', reader.error);
  }

  reader.readAsArrayBuffer(this._file.slice(startOffset, endOffset));
};

FileReadStream.prototype.destroy = function() {
  this._file = null;
  if (this.reader) {
    this.reader.onload = null;
    this.reader.onerror = null;
    try { this.reader.abort(); } catch (e) {};
  }
  this.reader = null;
}

},{"inherits":101,"stream":38,"typedarray-to-buffer":83}],86:[function(require,module,exports){
module.exports = function flatten(list, depth) {
  depth = (typeof depth == 'number') ? depth : Infinity;

  return _flatten(list, 1);

  function _flatten(list, d) {
    return list.reduce(function (acc, item) {
      if (Array.isArray(item) && d < depth) {
        return acc.concat(_flatten(item, d + 1));
      }
      else {
        return acc.concat(item);
      }
    }, []);
  }
};

},{}],87:[function(require,module,exports){
'use strict';

var fs = require('fs');

module.exports = function isFile(path, cb){
  if(!cb)return isFileSync(path);

  fs.stat(path, function(err, stats){
    if(err)return cb(err);
    return cb(null, stats.isFile());
  });
};

module.exports.sync = isFileSync;

function isFileSync(path){
  return fs.existsSync(path) && fs.statSync(path).isFile();
}

},{"fs":23}],88:[function(require,module,exports){
'use strict';

// // All
// /^npm-debug\.log$/,   // npm error log
// /^\..*\.swp$/,        // vim state
// // OS X
// /^\.DS_Store$/,       // stores custom folder attributes
// /^\.AppleDouble$/,    // stores additional file resources
// /^\.LSOverride$/,     // contains the absolute path to the app to be used
// /^Icon[\r\?]?/,       // custom Finder icon
// /^\._.*/,             // thumbnail
// /^\.Spotlight-V100$/,  // file that might appear on external disk
// /\.Trashes/,          // file that might appear on external disk
// /^__MACOSX$/,         // resource fork
// // Linux
// /~$/,                 // backup file
// // Windows
// /^Thumbs\.db$/,       // image file cache
// /^ehthumbs\.db$/,     // folder config file
// /^Desktop\.ini$/      // stores custom folder attributes

exports.re = /^npm-debug\.log$|^\..*\.swp$|^\.DS_Store$|^\.AppleDouble$|^\.LSOverride$|^Icon[\r\?]?|^\._.*|^\.Spotlight-V100$|\.Trashes|^__MACOSX$|~$|^Thumbs\.db$|^ehthumbs\.db$|^Desktop\.ini$/;

exports.is = function (filename) {
	return exports.re.test(filename);
};

exports.not = exports.isnt = function (filename) {
	return !exports.is(filename);
};

},{}],89:[function(require,module,exports){
arguments[4][20][0].apply(exports,arguments)
},{"dup":20}],90:[function(require,module,exports){
arguments[4][21][0].apply(exports,arguments)
},{"dup":21,"wrappy":89}],91:[function(require,module,exports){
var closest = require('closest-to')

// Create a range from 16kb–4mb
var sizes = []
for (var i = 14; i <= 22; i++) {
  sizes.push(Math.pow(2, i))
}

module.exports = function(size) {
  return closest(
    size / Math.pow(2, 10), sizes 
  )
}

},{"closest-to":92}],92:[function(require,module,exports){
module.exports = function(target, numbers) {
  var closest = Infinity
  var difference = 0
  var winner = null

  numbers.sort(function(a, b) {
    return a - b
  })

  for (var i = 0, l = numbers.length; i < l; i++) {  
    difference = Math.abs(target - numbers[i])
    if (difference >= closest) {
      break
    }
    closest = difference
    winner = numbers[i]
  }

  return winner
}

},{}],93:[function(require,module,exports){

/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = require('./debug');
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;
exports.storage = 'undefined' != typeof chrome
               && 'undefined' != typeof chrome.storage
                  ? chrome.storage.local
                  : localstorage();

/**
 * Colors.
 */

exports.colors = [
  'lightseagreen',
  'forestgreen',
  'goldenrod',
  'dodgerblue',
  'darkorchid',
  'crimson'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

function useColors() {
  // is webkit? http://stackoverflow.com/a/16459606/376773
  return ('WebkitAppearance' in document.documentElement.style) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (window.console && (console.firebug || (console.exception && console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31);
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  return JSON.stringify(v);
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs() {
  var args = arguments;
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return args;

  var c = 'color: ' + this.color;
  args = [args[0], c, 'color: inherit'].concat(Array.prototype.slice.call(args, 1));

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
  return args;
}

/**
 * Invokes `console.log()` when available.
 * No-op when `console.log` is not a "function".
 *
 * @api public
 */

function log() {
  // this hackery is required for IE8/9, where
  // the `console.log` function doesn't have 'apply'
  return 'object' === typeof console
    && console.log
    && Function.prototype.apply.call(console.log, console, arguments);
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  try {
    if (null == namespaces) {
      exports.storage.removeItem('debug');
    } else {
      exports.storage.debug = namespaces;
    }
  } catch(e) {}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  var r;
  try {
    r = exports.storage.debug;
  } catch(e) {}
  return r;
}

/**
 * Enable namespaces listed in `localStorage.debug` initially.
 */

exports.enable(load());

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage(){
  try {
    return window.localStorage;
  } catch (e) {}
}

},{"./debug":94}],94:[function(require,module,exports){

/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = debug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = require('ms');

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lowercased letter, i.e. "n".
 */

exports.formatters = {};

/**
 * Previously assigned color.
 */

var prevColor = 0;

/**
 * Previous log timestamp.
 */

var prevTime;

/**
 * Select a color.
 *
 * @return {Number}
 * @api private
 */

function selectColor() {
  return exports.colors[prevColor++ % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function debug(namespace) {

  // define the `disabled` version
  function disabled() {
  }
  disabled.enabled = false;

  // define the `enabled` version
  function enabled() {

    var self = enabled;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // add the `color` if not set
    if (null == self.useColors) self.useColors = exports.useColors();
    if (null == self.color && self.useColors) self.color = selectColor();

    var args = Array.prototype.slice.call(arguments);

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %o
      args = ['%o'].concat(args);
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-z%])/g, function(match, format) {
      // if we encounter an escaped % then don't increase the array index
      if (match === '%%') return match;
      index++;
      var formatter = exports.formatters[format];
      if ('function' === typeof formatter) {
        var val = args[index];
        match = formatter.call(self, val);

        // now we need to remove `args[index]` since it's inlined in the `format`
        args.splice(index, 1);
        index--;
      }
      return match;
    });

    if ('function' === typeof exports.formatArgs) {
      args = exports.formatArgs.apply(self, args);
    }
    var logFn = enabled.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }
  enabled.enabled = true;

  var fn = exports.enabled(namespace) ? enabled : disabled;

  fn.namespace = namespace;

  return fn;
}

/**
 * Enables a debug mode by namespaces. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} namespaces
 * @api public
 */

function enable(namespaces) {
  exports.save(namespaces);

  var split = (namespaces || '').split(/[\s,]+/);
  var len = split.length;

  for (var i = 0; i < len; i++) {
    if (!split[i]) continue; // ignore empty strings
    namespaces = split[i].replace(/\*/g, '.*?');
    if (namespaces[0] === '-') {
      exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
    } else {
      exports.names.push(new RegExp('^' + namespaces + '$'));
    }
  }
}

/**
 * Disable debug output.
 *
 * @api public
 */

function disable() {
  exports.enable('');
}

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

function enabled(name) {
  var i, len;
  for (i = 0, len = exports.skips.length; i < len; i++) {
    if (exports.skips[i].test(name)) {
      return false;
    }
  }
  for (i = 0, len = exports.names.length; i < len; i++) {
    if (exports.names[i].test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce `val`.
 *
 * @param {Mixed} val
 * @return {Mixed}
 * @api private
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}

},{"ms":95}],95:[function(require,module,exports){
/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var y = d * 365.25;

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} options
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options){
  options = options || {};
  if ('string' == typeof val) return parse(val);
  return options.long
    ? long(val)
    : short(val);
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = '' + str;
  if (str.length > 10000) return;
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(str);
  if (!match) return;
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function short(ms) {
  if (ms >= d) return Math.round(ms / d) + 'd';
  if (ms >= h) return Math.round(ms / h) + 'h';
  if (ms >= m) return Math.round(ms / m) + 'm';
  if (ms >= s) return Math.round(ms / s) + 's';
  return ms + 'ms';
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function long(ms) {
  return plural(ms, d, 'day')
    || plural(ms, h, 'hour')
    || plural(ms, m, 'minute')
    || plural(ms, s, 'second')
    || ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) return;
  if (ms < n * 1.5) return Math.floor(ms / n) + ' ' + name;
  return Math.ceil(ms / n) + ' ' + name + 's';
}

},{}],96:[function(require,module,exports){
var once = require('once');

var noop = function() {};

var isRequest = function(stream) {
	return stream.setHeader && typeof stream.abort === 'function';
};

var isChildProcess = function(stream) {
	return stream.stdio && Array.isArray(stream.stdio) && stream.stdio.length === 3
};

var eos = function(stream, opts, callback) {
	if (typeof opts === 'function') return eos(stream, null, opts);
	if (!opts) opts = {};

	callback = once(callback || noop);

	var ws = stream._writableState;
	var rs = stream._readableState;
	var readable = opts.readable || (opts.readable !== false && stream.readable);
	var writable = opts.writable || (opts.writable !== false && stream.writable);

	var onlegacyfinish = function() {
		if (!stream.writable) onfinish();
	};

	var onfinish = function() {
		writable = false;
		if (!readable) callback();
	};

	var onend = function() {
		readable = false;
		if (!writable) callback();
	};

	var onexit = function(exitCode) {
		callback(exitCode ? new Error('exited with error code: ' + exitCode) : null);
	};

	var onclose = function() {
		if (readable && !(rs && rs.ended)) return callback(new Error('premature close'));
		if (writable && !(ws && ws.ended)) return callback(new Error('premature close'));
	};

	var onrequest = function() {
		stream.req.on('finish', onfinish);
	};

	if (isRequest(stream)) {
		stream.on('complete', onfinish);
		stream.on('abort', onclose);
		if (stream.req) onrequest();
		else stream.on('request', onrequest);
	} else if (writable && !ws) { // legacy streams
		stream.on('end', onlegacyfinish);
		stream.on('close', onlegacyfinish);
	}

	if (isChildProcess(stream)) stream.on('exit', onexit);

	stream.on('end', onend);
	stream.on('finish', onfinish);
	if (opts.error !== false) stream.on('error', callback);
	stream.on('close', onclose);

	return function() {
		stream.removeListener('complete', onfinish);
		stream.removeListener('abort', onclose);
		stream.removeListener('request', onrequest);
		if (stream.req) stream.req.removeListener('finish', onfinish);
		stream.removeListener('end', onlegacyfinish);
		stream.removeListener('close', onlegacyfinish);
		stream.removeListener('finish', onfinish);
		stream.removeListener('exit', onexit);
		stream.removeListener('end', onend);
		stream.removeListener('error', callback);
		stream.removeListener('close', onclose);
	};
};

module.exports = eos;
},{"once":98}],97:[function(require,module,exports){
arguments[4][20][0].apply(exports,arguments)
},{"dup":20}],98:[function(require,module,exports){
arguments[4][21][0].apply(exports,arguments)
},{"dup":21,"wrappy":97}],99:[function(require,module,exports){
var hat = module.exports = function (bits, base) {
    if (!base) base = 16;
    if (bits === undefined) bits = 128;
    if (bits <= 0) return '0';
    
    var digits = Math.log(Math.pow(2, bits)) / Math.log(base);
    for (var i = 2; digits === Infinity; i *= 2) {
        digits = Math.log(Math.pow(2, bits / i)) / Math.log(base) * i;
    }
    
    var rem = digits - Math.floor(digits);
    
    var res = '';
    
    for (var i = 0; i < Math.floor(digits); i++) {
        var x = Math.floor(Math.random() * base).toString(base);
        res = x + res;
    }
    
    if (rem) {
        var b = Math.pow(base, rem);
        var x = Math.floor(Math.random() * b).toString(base);
        res = x + res;
    }
    
    var parsed = parseInt(res, base);
    if (parsed !== Infinity && parsed >= Math.pow(2, bits)) {
        return hat(bits, base)
    }
    else return res;
};

hat.rack = function (bits, base, expandBy) {
    var fn = function (data) {
        var iters = 0;
        do {
            if (iters ++ > 10) {
                if (expandBy) bits += expandBy;
                else throw new Error('too many ID collisions, use more bits')
            }
            
            var id = hat(bits, base);
        } while (Object.hasOwnProperty.call(hats, id));
        
        hats[id] = data;
        return id;
    };
    var hats = fn.hats = {};
    
    fn.get = function (id) {
        return fn.hats[id];
    };
    
    fn.set = function (id, value) {
        fn.hats[id] = value;
        return fn;
    };
    
    fn.bits = bits || 128;
    fn.base = base || 16;
    return fn;
};

},{}],100:[function(require,module,exports){
(function (process){
module.exports = ImmediateStore

function ImmediateStore (store) {
  if (!(this instanceof ImmediateStore)) return new ImmediateStore(store)

  this.store = store
  if (!this.store || !this.store.get || !this.store.put) {
    throw new Error('First argument must be abstract-chunk-store compliant')
  }

  this.mem = []
}

ImmediateStore.prototype.put = function (index, buf, cb) {
  var self = this
  self.mem[index] = buf
  self.store.put(index, buf, function (err) {
    self.mem[index] = null
    if (cb) cb(err)
  })
}

ImmediateStore.prototype.get = function (index, opts, cb) {
  if (typeof opts === 'function') return this.get(index, null, opts)

  var start = (opts && opts.offset) || 0
  var end = opts && opts.length && (start + opts.length)

  var buf = this.mem[index]
  if (buf) return nextTick(cb, null, opts ? buf.slice(start, end) : buf)

  this.store.get(index, opts, cb)
}

ImmediateStore.prototype.close = function (cb) {
  this.store.close(cb)
}

ImmediateStore.prototype.destroy = function (cb) {
  this.store.destroy(cb)
}

function nextTick (cb, err, val) {
  process.nextTick(function () {
    if (cb) cb(err, val)
  })
}

}).call(this,require('_process'))
},{"_process":33}],101:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],102:[function(require,module,exports){
module.exports = MediaSourceStream

var inherits = require('inherits')
var stream = require('stream')

var MediaSource = typeof window !== 'undefined' && window.MediaSource

inherits(MediaSourceStream, stream.Writable)

function MediaSourceStream (elem, opts) {
  var self = this
  if (!(self instanceof MediaSourceStream)) return new MediaSourceStream(elem, opts)
  stream.Writable.call(self, opts)

  if (!MediaSource) throw new Error('web browser lacks MediaSource support')
  if (!opts) opts = {}

  self._elem = elem
  self._mediaSource = new MediaSource()
  self._sourceBuffer = null
  self._cb = null

  self._type = opts.type || getType(opts.extname)
  if (!self._type) throw new Error('missing `opts.type` or `opts.extname` options')

  self._elem.src = window.URL.createObjectURL(self._mediaSource)

  self._mediaSource.addEventListener('sourceopen', function () {
    if (MediaSource.isTypeSupported(self._type)) {
      self._sourceBuffer = self._mediaSource.addSourceBuffer(self._type)
      self._sourceBuffer.addEventListener('updateend', self._flow.bind(self))
      self._flow()
    } else {
      self._mediaSource.endOfStream('decode')
    }
  })

  self.on('finish', function () {
    self._mediaSource.endOfStream()
  })
}

MediaSourceStream.prototype._write = function (chunk, encoding, cb) {
  var self = this
  if (!self._sourceBuffer) {
    self._cb = function (err) {
      if (err) return cb(err)
      self._write(chunk, encoding, cb)
    }
    return
  }

  if (self._sourceBuffer.updating) {
    return cb(new Error('Cannot append buffer while source buffer updating'))
  }

  self._sourceBuffer.appendBuffer(chunk)
  self._cb = cb
}

MediaSourceStream.prototype._flow = function () {
  var self = this
  if (self._cb) {
    self._cb(null)
  }
}

function getType (extname) {
  if (!extname) return null
  if (extname[0] !== '.') extname = '.' + extname
  return {
    '.m4a': 'audio/mp4; codecs="mp4a.40.5"',
    '.m4v': 'video/mp4; codecs="avc1.640029, mp4a.40.5"',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4; codecs="avc1.640029, mp4a.40.5"',
    '.webm': 'video/webm; codecs="vorbis, vp8"'
  }[extname]
}

},{"inherits":101,"stream":38}],103:[function(require,module,exports){
(function (process){
module.exports = Storage

function Storage (chunkLength, opts) {
  if (!(this instanceof Storage)) return new Storage(chunkLength, opts)
  if (!opts) opts = {}

  this.chunkLength = Number(chunkLength)
  if (!this.chunkLength) throw new Error('First argument must be a chunk length')

  this.chunks = []
  this.closed = false
  this.length = Number(opts.length) || Infinity

  if (this.length !== Infinity) {
    this.lastChunkLength = (this.length % this.chunkLength) || this.chunkLength
    this.lastChunkIndex = Math.ceil(this.length / this.chunkLength) - 1
  }
}

Storage.prototype.put = function (index, buf, cb) {
  if (this.closed) return nextTick(cb, new Error('Storage is closed'))

  var isLastChunk = (index === this.lastChunkIndex)
  if (isLastChunk && buf.length !== this.lastChunkLength) {
    return nextTick(cb, new Error('Last chunk length must be ' + this.lastChunkLength))
  }
  if (!isLastChunk && buf.length !== this.chunkLength) {
    return nextTick(cb, new Error('Chunk length must be ' + this.chunkLength))
  }
  this.chunks[index] = buf
  nextTick(cb, null)
}

Storage.prototype.get = function (index, opts, cb) {
  if (typeof opts === 'function') return this.get(index, null, opts)
  if (this.closed) return nextTick(cb, new Error('Storage is closed'))
  var buf = this.chunks[index]
  if (!buf) return nextTick(cb, new Error('Chunk not found'))
  if (!opts) return nextTick(cb, null, buf)
  var offset = opts.offset || 0
  var len = opts.length || (buf.length - offset)
  nextTick(cb, null, buf.slice(offset, len + offset))
}

Storage.prototype.close = Storage.prototype.destroy = function (cb) {
  if (this.closed) return nextTick(cb, new Error('Storage is closed'))
  this.closed = true
  this.chunks = null
  nextTick(cb, null)
}

function nextTick (cb, err, val) {
  process.nextTick(function () {
    if (cb) cb(err, val)
  })
}

}).call(this,require('_process'))
},{"_process":33}],104:[function(require,module,exports){
module.exports = MultiStream

var inherits = require('inherits')
var stream = require('stream')

inherits(MultiStream, stream.Readable)

function MultiStream (streams, opts) {
  if (!(this instanceof MultiStream)) return new MultiStream(streams, opts)
  stream.Readable.call(this, opts)

  this.destroyed = false

  this._drained = false
  this._forwarding = false
  this._current = null
  this._queue = (typeof streams === 'function' ? streams : streams.map(toStreams2))

  this._next()
}

MultiStream.obj = function (streams) {
  return new MultiStream(streams, { objectMode: true, highWaterMark: 16 })
}

MultiStream.prototype._read = function () {
  this._drained = true
  this._forward()
}

MultiStream.prototype._forward = function () {
  if (this._forwarding || !this._drained || !this._current) return
  this._forwarding = true

  var chunk
  while ((chunk = this._current.read()) !== null) {
    this._drained = this.push(chunk)
  }

  this._forwarding = false
}

MultiStream.prototype.destroy = function (err) {
  if (this.destroyed) return
  this.destroyed = true

  if (this._current && this._current.destroy) this._current.destroy()
  if (typeof this._queue !== 'function') {
    this._queue.forEach(function (stream) {
      if (stream.destroy) stream.destroy()
    })
  }

  if (err) this.emit('error', err)
  this.emit('close')
}

MultiStream.prototype._next = function () {
  var self = this
  self._current = null

  if (typeof self._queue === 'function') {
    self._queue(function (err, stream) {
      if (err) return self.destroy(err)
      self._gotNextStream(toStreams2(stream))
    })
  } else {
    var stream = self._queue.shift()
    if (typeof stream === 'function') stream = toStreams2(stream())
    self._gotNextStream(stream)
  }
}

MultiStream.prototype._gotNextStream = function (stream) {
  var self = this

  if (!stream) {
    self.push(null)
    self.destroy()
    return
  }

  self._current = stream
  self._forward()

  stream.on('readable', onReadable)
  stream.on('end', onEnd)
  stream.on('error', onError)
  stream.on('close', onClose)

  function onReadable () {
    self._forward()
  }

  function onClose () {
    if (!stream._readableState.ended) {
      self.destroy()
    }
  }

  function onEnd () {
    self._current = null
    stream.removeListener('readable', onReadable)
    stream.removeListener('end', onEnd)
    stream.removeListener('error', onError)
    stream.removeListener('close', onClose)
    self._next()
  }

  function onError (err) {
    self.destroy(err)
  }
}

function toStreams2 (s) {
  if (!s || typeof s === 'function' || s._readableState) return s

  var wrap = new stream.Readable().wrap(s)
  if (s.destroy) {
    wrap.destroy = s.destroy.bind(s)
  }
  return wrap
}

},{"inherits":101,"stream":38}],105:[function(require,module,exports){
(function (Buffer,process){
/* global Blob */

module.exports = parseTorrent
module.exports.remote = parseTorrentRemote

var blobToBuffer = require('blob-to-buffer')
var fs = require('fs') // browser exclude
var get = require('simple-get')
var magnet = require('magnet-uri')
var parseTorrentFile = require('parse-torrent-file')

module.exports.toMagnetURI = magnet.encode
module.exports.toTorrentFile = parseTorrentFile.encode

/**
 * Parse a torrent identifier (magnet uri, .torrent file, info hash)
 * @param  {string|Buffer|Object} torrentId
 * @return {Object}
 */
function parseTorrent (torrentId) {
  if (typeof torrentId === 'string' && /magnet:/.test(torrentId)) {
    // magnet uri (string)
    return magnet(torrentId)
  } else if (typeof torrentId === 'string' && (/^[a-f0-9]{40}$/i.test(torrentId) || /^[a-z2-7]{32}$/i.test(torrentId))) {
    // info hash (hex/base-32 string)
    return magnet('magnet:?xt=urn:btih:' + torrentId)
  } else if (Buffer.isBuffer(torrentId) && torrentId.length === 20) {
    // info hash (buffer)
    return magnet('magnet:?xt=urn:btih:' + torrentId.toString('hex'))
  } else if (Buffer.isBuffer(torrentId)) {
    // .torrent file (buffer)
    return parseTorrentFile(torrentId) // might throw
  } else if (torrentId && torrentId.infoHash) {
    // parsed torrent (from `parse-torrent`, `parse-torrent-file`, or `magnet-uri`)
    if (!torrentId.announce) torrentId.announce = []
    if (typeof torrentId.announce === 'string') {
      torrentId.announce = [ torrentId.announce ]
    }
    if (!torrentId.urlList) torrentId.urlList = []
    return torrentId
  } else {
    throw new Error('Invalid torrent identifier')
  }
}

function parseTorrentRemote (torrentId, cb) {
  var parsedTorrent
  if (typeof cb !== 'function') throw new Error('second argument must be a Function')

  try {
    parsedTorrent = parseTorrent(torrentId)
  } catch (err) {
    // If torrent fails to parse, it could be a Blob, http/https URL or
    // filesystem path, so don't consider it an error yet.
  }

  if (parsedTorrent && parsedTorrent.infoHash) {
    process.nextTick(function () {
      cb(null, parsedTorrent)
    })
  } else if (isBlob(torrentId)) {
    blobToBuffer(torrentId, function (err, torrentBuf) {
      if (err) return cb(new Error('Error converting Blob: ' + err.message))
      parseOrThrow(torrentBuf)
    })
  } else if (typeof get === 'function' && /^https?:/.test(torrentId)) {
    // http, or https url to torrent file
    get.concat({
      url: torrentId,
      headers: { 'user-agent': 'WebTorrent (http://webtorrent.io)' }
    }, function (err, torrentBuf) {
      if (err) return cb(new Error('Error downloading torrent: ' + err.message))
      parseOrThrow(torrentBuf)
    })
  } else if (typeof fs.readFile === 'function' && typeof torrentId === 'string') {
    // assume it's a filesystem path
    fs.readFile(torrentId, function (err, torrentBuf) {
      if (err) return cb(new Error('Invalid torrent identifier'))
      parseOrThrow(torrentBuf)
    })
  } else {
    process.nextTick(function () {
      cb(new Error('Invalid torrent identifier'))
    })
  }

  function parseOrThrow (torrentBuf) {
    try {
      parsedTorrent = parseTorrent(torrentBuf)
    } catch (err) {
      return cb(err)
    }
    if (parsedTorrent && parsedTorrent.infoHash) cb(null, parsedTorrent)
    else cb(new Error('Invalid torrent identifier'))
  }
}

/**
 * Check if `obj` is a W3C `Blob` or `File` object
 * @param  {*} obj
 * @return {boolean}
 */
function isBlob (obj) {
  return typeof Blob !== 'undefined' && obj instanceof Blob
}

}).call(this,{"isBuffer":require("../browserify/node_modules/insert-module-globals/node_modules/is-buffer/index.js")},require('_process'))
},{"../browserify/node_modules/insert-module-globals/node_modules/is-buffer/index.js":31,"_process":33,"blob-to-buffer":106,"fs":23,"magnet-uri":109,"parse-torrent-file":112,"simple-get":140}],106:[function(require,module,exports){
/* global Blob, FileReader */

// arraybuffer -> buffer without copy
var toBuffer = require('typedarray-to-buffer')

module.exports = function blobToBuffer (blob, cb) {
  if (typeof Blob === 'undefined' || !(blob instanceof Blob)) {
    throw new Error('first argument must be a Blob')
  }
  if (typeof cb !== 'function') {
    throw new Error('second argument must be a function')
  }

  var reader = new FileReader()

  function onLoadEnd (e) {
    reader.removeEventListener('loadend', onLoadEnd, false)
    if (e.error) cb(e.error)
    else cb(null, toBuffer(reader.result))
  }

  reader.addEventListener('loadend', onLoadEnd, false)
  reader.readAsArrayBuffer(blob)
}

},{"typedarray-to-buffer":107}],107:[function(require,module,exports){
arguments[4][83][0].apply(exports,arguments)
},{"buffer":25,"dup":83,"is-typedarray":108}],108:[function(require,module,exports){
arguments[4][84][0].apply(exports,arguments)
},{"dup":84}],109:[function(require,module,exports){
(function (Buffer){
module.exports = magnetURIDecode
module.exports.decode = magnetURIDecode
module.exports.encode = magnetURIEncode

var base32 = require('thirty-two')
var extend = require('xtend')
var uniq = require('uniq')

/**
 * Parse a magnet URI and return an object of keys/values
 *
 * @param  {string} uri
 * @return {Object} parsed uri
 */
function magnetURIDecode (uri) {
  var result = {}
  var data = uri.split('magnet:?')[1]

  var params = (data && data.length >= 0)
    ? data.split('&')
    : []

  params.forEach(function (param) {
    var keyval = param.split('=')

    // This keyval is invalid, skip it
    if (keyval.length !== 2) return

    var key = keyval[0]
    var val = keyval[1]

    // Clean up torrent name
    if (key === 'dn') val = decodeURIComponent(val).replace(/\+/g, ' ')

    // Address tracker (tr), exact source (xs), and acceptable source (as) are encoded
    // URIs, so decode them
    if (key === 'tr' || key === 'xs' || key === 'as' || key === 'ws') {
      val = decodeURIComponent(val)
    }

    // Return keywords as an array
    if (key === 'kt') val = decodeURIComponent(val).split('+')

    // If there are repeated parameters, return an array of values
    if (result[key]) {
      if (Array.isArray(result[key])) {
        result[key].push(val)
      } else {
        var old = result[key]
        result[key] = [old, val]
      }
    } else {
      result[key] = val
    }
  })

  // Convenience properties for parity with `parse-torrent-file` module
  var m
  if (result.xt) {
    var xts = Array.isArray(result.xt) ? result.xt : [ result.xt ]
    xts.forEach(function (xt) {
      if ((m = xt.match(/^urn:btih:(.{40})/))) {
        result.infoHash = m[1].toLowerCase()
      } else if ((m = xt.match(/^urn:btih:(.{32})/))) {
        var decodedStr = base32.decode(m[1])
        result.infoHash = new Buffer(decodedStr, 'binary').toString('hex')
      }
    })
  }
  if (result.infoHash) result.infoHashBuffer = new Buffer(result.infoHash, 'hex')

  if (result.dn) result.name = result.dn
  if (result.kt) result.keywords = result.kt

  if (typeof result.tr === 'string') result.announce = [ result.tr ]
  else if (Array.isArray(result.tr)) result.announce = result.tr
  else result.announce = []

  uniq(result.announce)

  result.urlList = []
  if (typeof result.as === 'string' || Array.isArray(result.as)) {
    result.urlList = result.urlList.concat(result.as)
  }
  if (typeof result.ws === 'string' || Array.isArray(result.ws)) {
    result.urlList = result.urlList.concat(result.ws)
  }

  return result
}

function magnetURIEncode (obj) {
  obj = extend(obj) // clone obj, so we can mutate it

  // support using convenience names, in addition to spec names
  // (example: `infoHash` for `xt`, `name` for `dn`)
  if (obj.infoHashBuffer) obj.xt = 'urn:btih:' + obj.infoHashBuffer.toString('hex')
  if (obj.infoHash) obj.xt = 'urn:btih:' + obj.infoHash
  if (obj.name) obj.dn = obj.name
  if (obj.keywords) obj.kt = obj.keywords
  if (obj.announce) obj.tr = obj.announce
  if (obj.urlList) {
    obj.ws = obj.urlList
    delete obj.as
  }

  var result = 'magnet:?'
  Object.keys(obj)
    .filter(function (key) {
      return key.length === 2
    })
    .forEach(function (key, i) {
      var values = Array.isArray(obj[key]) ? obj[key] : [ obj[key] ]
      values.forEach(function (val, j) {
        if ((i > 0 || j > 0) && (key !== 'kt' || j === 0)) result += '&'

        if (key === 'dn') val = encodeURIComponent(val).replace(/%20/g, '+')
        if (key === 'tr' || key === 'xs' || key === 'as' || key === 'ws') {
          val = encodeURIComponent(val)
        }
        if (key === 'kt') val = encodeURIComponent(val)

        if (key === 'kt' && j > 0) result += '+' + val
        else result += key + '=' + val
      })
    })

  return result
}

}).call(this,require("buffer").Buffer)
},{"buffer":25,"thirty-two":110,"uniq":158,"xtend":172}],110:[function(require,module,exports){
/*                                                                              
Copyright (c) 2011, Chris Umbel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in      
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN 
THE SOFTWARE.
*/

var base32 = require('./thirty-two');

exports.encode = base32.encode;
exports.decode = base32.decode;

},{"./thirty-two":111}],111:[function(require,module,exports){
(function (Buffer){
/*                                                                              
Copyright (c) 2011, Chris Umbel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.                                                                   
*/

var charTable = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
var byteTable = [
    0xff, 0xff, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
    0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
    0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16,
    0x17, 0x18, 0x19, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
    0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
    0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16,
    0x17, 0x18, 0x19, 0xff, 0xff, 0xff, 0xff, 0xff
];

function quintetCount(buff) {
    var quintets = Math.floor(buff.length / 5);
    return buff.length % 5 == 0 ? quintets: quintets + 1;
}

exports.encode = function(plain) {
    if(!Buffer.isBuffer(plain)){
    	plain = new Buffer(plain);
    }
    var i = 0;
    var j = 0;
    var shiftIndex = 0;
    var digit = 0;
    var encoded = new Buffer(quintetCount(plain) * 8);

    /* byte by byte isn't as pretty as quintet by quintet but tests a bit
        faster. will have to revisit. */
    while(i < plain.length) {
        var current = plain[i];
    
        if(shiftIndex > 3) {
            digit = current & (0xff >> shiftIndex);
            shiftIndex = (shiftIndex + 5) % 8;
            digit = (digit << shiftIndex) | ((i + 1 < plain.length) ?
                plain[i + 1] : 0) >> (8 - shiftIndex);
            i++;
        } else {
            digit = (current >> (8 - (shiftIndex + 5))) & 0x1f;
            shiftIndex = (shiftIndex + 5) % 8;            
            if(shiftIndex == 0) i++;
        }
        
        encoded[j] = charTable.charCodeAt(digit);
        j++;
    }

    for(i = j; i < encoded.length; i++)
        encoded[i] = 0x3d; //'='.charCodeAt(0)
        
    return encoded;
};

exports.decode = function(encoded) {
    var shiftIndex = 0;
    var plainDigit = 0;
    var plainChar;
    var plainPos = 0;
    if(!Buffer.isBuffer(encoded)){
    	encoded = new Buffer(encoded);
    }
    var decoded = new Buffer(Math.ceil(encoded.length * 5 / 8));
    
    /* byte by byte isn't as pretty as octet by octet but tests a bit
        faster. will have to revisit. */    
    for(var i = 0; i < encoded.length; i++) {
    	if(encoded[i] == 0x3d){ //'='
    		break;
    	}
    		
        var encodedByte = encoded[i] - 0x30;
        
        if(encodedByte < byteTable.length) {
            plainDigit = byteTable[encodedByte];
            
            if(shiftIndex <= 3) {
                shiftIndex = (shiftIndex + 5) % 8;
                
                if(shiftIndex == 0) {
                    plainChar |= plainDigit;
                    decoded[plainPos] = plainChar;
                    plainPos++;
                    plainChar = 0;
                } else {
                    plainChar |= 0xff & (plainDigit << (8 - shiftIndex));
                }
            } else {
                shiftIndex = (shiftIndex + 5) % 8;
                plainChar |= 0xff & (plainDigit >>> shiftIndex);
                decoded[plainPos] = plainChar;
                plainPos++;

                plainChar = 0xff & (plainDigit << (8 - shiftIndex));
            }
        } else {
        	throw new Error('Invalid input - it is not base32 encoded string');
        }
    }
    return decoded.slice(0, plainPos);
};

}).call(this,require("buffer").Buffer)
},{"buffer":25}],112:[function(require,module,exports){
(function (Buffer){
module.exports = decodeTorrentFile
module.exports.decode = decodeTorrentFile
module.exports.encode = encodeTorrentFile

var bencode = require('bencode')
var path = require('path')
var sha1 = require('simple-sha1')
var uniq = require('uniq')

/**
 * Parse a torrent. Throws an exception if the torrent is missing required fields.
 * @param  {Buffer|Object} torrent
 * @return {Object}        parsed torrent
 */
function decodeTorrentFile (torrent) {
  if (Buffer.isBuffer(torrent)) {
    torrent = bencode.decode(torrent)
  }

  // sanity check
  ensure(torrent.info, 'info')
  ensure(torrent.info['name.utf-8'] || torrent.info.name, 'info.name')
  ensure(torrent.info['piece length'], 'info[\'piece length\']')
  ensure(torrent.info.pieces, 'info.pieces')

  if (torrent.info.files) {
    torrent.info.files.forEach(function (file) {
      ensure(typeof file.length === 'number', 'info.files[0].length')
      ensure(file['path.utf-8'] || file.path, 'info.files[0].path')
    })
  } else {
    ensure(typeof torrent.info.length === 'number', 'info.length')
  }

  var result = {}
  result.info = torrent.info
  result.infoBuffer = bencode.encode(torrent.info)
  result.infoHash = sha1.sync(result.infoBuffer)
  result.infoHashBuffer = new Buffer(result.infoHash, 'hex')

  result.name = (torrent.info['name.utf-8'] || torrent.info.name).toString()

  if (torrent.info.private !== undefined) result.private = !!torrent.info.private

  if (torrent['creation date']) result.created = new Date(torrent['creation date'] * 1000)
  if (torrent['created by']) result.createdBy = torrent['created by'].toString()

  if (Buffer.isBuffer(torrent.comment)) result.comment = torrent.comment.toString()

  // announce and announce-list will be missing if metadata fetched via ut_metadata
  result.announce = []
  if (torrent['announce-list'] && torrent['announce-list'].length) {
    torrent['announce-list'].forEach(function (urls) {
      urls.forEach(function (url) {
        result.announce.push(url.toString())
      })
    })
  } else if (torrent.announce) {
    result.announce.push(torrent.announce.toString())
  }

  uniq(result.announce)

  // handle url-list (BEP19 / web seeding)
  if (Buffer.isBuffer(torrent['url-list'])) {
    // some clients set url-list to empty string
    torrent['url-list'] = torrent['url-list'].length > 0
      ? [ torrent['url-list'] ]
      : []
  }
  result.urlList = (torrent['url-list'] || []).map(function (url) {
    return url.toString()
  })

  var files = torrent.info.files || [ torrent.info ]
  result.files = files.map(function (file, i) {
    var parts = [].concat(result.name, file['path.utf-8'] || file.path || []).map(function (p) {
      return p.toString()
    })
    return {
      path: path.join.apply(null, [path.sep].concat(parts)).slice(1),
      name: parts[parts.length - 1],
      length: file.length,
      offset: files.slice(0, i).reduce(sumLength, 0)
    }
  })

  result.length = files.reduce(sumLength, 0)

  var lastFile = result.files[result.files.length - 1]

  result.pieceLength = torrent.info['piece length']
  result.lastPieceLength = ((lastFile.offset + lastFile.length) % result.pieceLength) || result.pieceLength
  result.pieces = splitPieces(torrent.info.pieces)

  return result
}

/**
 * Convert a parsed torrent object back into a .torrent file buffer.
 * @param  {Object} parsed parsed torrent
 * @return {Buffer}
 */
function encodeTorrentFile (parsed) {
  var torrent = {
    info: parsed.info
  }

  torrent['announce-list'] = parsed.announce.map(function (url) {
    if (!torrent.announce) torrent.announce = url
    url = new Buffer(url, 'utf8')
    return [ url ]
  })

  if (parsed.created) {
    torrent['creation date'] = (parsed.created.getTime() / 1000) | 0
  }
  if (parsed.urlList) {
    torrent['url-list'] = parsed.urlList
  }
  return bencode.encode(torrent)
}

function sumLength (sum, file) {
  return sum + file.length
}

function splitPieces (buf) {
  var pieces = []
  for (var i = 0; i < buf.length; i += 20) {
    pieces.push(buf.slice(i, i + 20).toString('hex'))
  }
  return pieces
}

function ensure (bool, fieldName) {
  if (!bool) throw new Error('Torrent is missing required field: ' + fieldName)
}

}).call(this,require("buffer").Buffer)
},{"bencode":113,"buffer":25,"path":32,"simple-sha1":147,"uniq":158}],113:[function(require,module,exports){
arguments[4][62][0].apply(exports,arguments)
},{"./lib/decode":114,"./lib/encode":116,"dup":62}],114:[function(require,module,exports){
arguments[4][63][0].apply(exports,arguments)
},{"./dict":115,"buffer":25,"dup":63}],115:[function(require,module,exports){
arguments[4][14][0].apply(exports,arguments)
},{"dup":14}],116:[function(require,module,exports){
arguments[4][65][0].apply(exports,arguments)
},{"buffer":25,"dup":65}],117:[function(require,module,exports){
var once = require('once')
var eos = require('end-of-stream')
var fs = require('fs') // we only need fs to get the ReadStream and WriteStream prototypes

var noop = function () {}

var isFn = function (fn) {
  return typeof fn === 'function'
}

var isFS = function (stream) {
  return (stream instanceof (fs.ReadStream || noop) || stream instanceof (fs.WriteStream || noop)) && isFn(stream.close)
}

var isRequest = function (stream) {
  return stream.setHeader && isFn(stream.abort)
}

var destroyer = function (stream, reading, writing, callback) {
  callback = once(callback)

  var closed = false
  stream.on('close', function () {
    closed = true
  })

  eos(stream, {readable: reading, writable: writing}, function (err) {
    if (err) return callback(err)
    closed = true
    callback()
  })

  var destroyed = false
  return function (err) {
    if (closed) return
    if (destroyed) return
    destroyed = true

    if (isFS(stream)) return stream.close() // use close for fs streams to avoid fd leaks
    if (isRequest(stream)) return stream.abort() // request.destroy just do .end - .abort is what we want

    if (isFn(stream.destroy)) return stream.destroy()

    callback(err || new Error('stream was destroyed'))
  }
}

var call = function (fn) {
  fn()
}

var pipe = function (from, to) {
  return from.pipe(to)
}

var pump = function () {
  var streams = Array.prototype.slice.call(arguments)
  var callback = isFn(streams[streams.length - 1] || noop) && streams.pop() || noop

  if (Array.isArray(streams[0])) streams = streams[0]
  if (streams.length < 2) throw new Error('pump requires two streams per minimum')

  var error
  var destroys = streams.map(function (stream, i) {
    var reading = i < streams.length - 1
    var writing = i > 0
    return destroyer(stream, reading, writing, function (err) {
      if (!error) error = err
      if (err) destroys.forEach(call)
      if (reading) return
      destroys.forEach(call)
      callback(error)
    })
  })

  return streams.reduce(pipe)
}

module.exports = pump

},{"end-of-stream":96,"fs":23,"once":119}],118:[function(require,module,exports){
arguments[4][20][0].apply(exports,arguments)
},{"dup":20}],119:[function(require,module,exports){
arguments[4][21][0].apply(exports,arguments)
},{"dup":21,"wrappy":118}],120:[function(require,module,exports){
var iterate = function (list) {
  var offset = 0
  return function () {
    if (offset === list.length) return null

    var len = list.length - offset
    var i = (Math.random() * len) | 0
    var el = list[offset + i]

    var tmp = list[offset]
    list[offset] = el
    list[offset + i] = tmp
    offset++

    return el
  }
}

module.exports = iterate

},{}],121:[function(require,module,exports){
module.exports = require("./lib/_stream_duplex.js")

},{"./lib/_stream_duplex.js":122}],122:[function(require,module,exports){
arguments[4][49][0].apply(exports,arguments)
},{"./_stream_readable":124,"./_stream_writable":126,"core-util-is":127,"dup":49,"inherits":101,"process-nextick-args":129}],123:[function(require,module,exports){
arguments[4][50][0].apply(exports,arguments)
},{"./_stream_transform":125,"core-util-is":127,"dup":50,"inherits":101}],124:[function(require,module,exports){
arguments[4][51][0].apply(exports,arguments)
},{"./_stream_duplex":122,"_process":33,"buffer":25,"core-util-is":127,"dup":51,"events":29,"inherits":101,"isarray":128,"process-nextick-args":129,"string_decoder/":130,"util":24}],125:[function(require,module,exports){
arguments[4][52][0].apply(exports,arguments)
},{"./_stream_duplex":122,"core-util-is":127,"dup":52,"inherits":101}],126:[function(require,module,exports){
arguments[4][53][0].apply(exports,arguments)
},{"./_stream_duplex":122,"buffer":25,"core-util-is":127,"dup":53,"events":29,"inherits":101,"process-nextick-args":129,"util-deprecate":131}],127:[function(require,module,exports){
(function (Buffer){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.

function isArray(arg) {
  if (Array.isArray) {
    return Array.isArray(arg);
  }
  return objectToString(arg) === '[object Array]';
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = Buffer.isBuffer;

function objectToString(o) {
  return Object.prototype.toString.call(o);
}

}).call(this,{"isBuffer":require("../../../../browserify/node_modules/insert-module-globals/node_modules/is-buffer/index.js")})
},{"../../../../browserify/node_modules/insert-module-globals/node_modules/is-buffer/index.js":31}],128:[function(require,module,exports){
arguments[4][55][0].apply(exports,arguments)
},{"dup":55}],129:[function(require,module,exports){
arguments[4][56][0].apply(exports,arguments)
},{"_process":33,"dup":56}],130:[function(require,module,exports){
arguments[4][57][0].apply(exports,arguments)
},{"buffer":25,"dup":57}],131:[function(require,module,exports){
arguments[4][58][0].apply(exports,arguments)
},{"dup":58}],132:[function(require,module,exports){
module.exports = require("./lib/_stream_passthrough.js")

},{"./lib/_stream_passthrough.js":123}],133:[function(require,module,exports){
arguments[4][59][0].apply(exports,arguments)
},{"./lib/_stream_duplex.js":122,"./lib/_stream_passthrough.js":123,"./lib/_stream_readable.js":124,"./lib/_stream_transform.js":125,"./lib/_stream_writable.js":126,"dup":59}],134:[function(require,module,exports){
module.exports = require("./lib/_stream_transform.js")

},{"./lib/_stream_transform.js":125}],135:[function(require,module,exports){
module.exports = require("./lib/_stream_writable.js")

},{"./lib/_stream_writable.js":126}],136:[function(require,module,exports){
(function (process){
exports.render = render
exports.append = append
var mime = exports.mime = require('./lib/mime')

var debug = require('debug')('render-media')
var MediaSourceStream = require('mediasource')
var path = require('path')
var streamToBlobURL = require('stream-to-blob-url')
var videostream = require('videostream')

var VIDEOSTREAM_EXTS = [ '.mp4', '.m4v', '.m4a' ]

var MEDIASOURCE_VIDEO_EXTS = [ '.mp4', '.m4v', '.webm' ]
var MEDIASOURCE_AUDIO_EXTS = [ '.m4a', '.mp3' ]
var MEDIASOURCE_EXTS = MEDIASOURCE_VIDEO_EXTS.concat(MEDIASOURCE_AUDIO_EXTS)

var AUDIO_EXTS = [ '.wav', '.aac', '.ogg', '.oga' ]
var IMAGE_EXTS = [ '.jpg', '.jpeg', '.png', '.gif', '.bmp' ]
var IFRAME_EXTS = [ '.css', '.html', '.js', '.md', '.pdf', '.txt' ]

var MediaSource = typeof window !== 'undefined' && window.MediaSource

function render (file, elem, cb) {
  validateFile(file)
  if (typeof elem === 'string') elem = document.querySelector(elem)

  renderMedia(file, function (tagName) {
    if (elem.nodeName !== tagName.toUpperCase()) {
      var extname = path.extname(file.name).toLowerCase()

      throw new Error(
        'Cannot render "' + extname + '" inside a "' +
        elem.nodeName.toLowerCase() + '" element, expected "' + tagName + '"'
      )
    }

    return elem
  }, cb)
}

function append (file, rootElem, cb) {
  validateFile(file)
  if (typeof rootElem === 'string') rootElem = document.querySelector(rootElem)

  if (rootElem && (rootElem.nodeName === 'VIDEO' || rootElem.nodeName === 'AUDIO')) {
    throw new Error(
      'Invalid video/audio node argument. Argument must be root element that ' +
      'video/audio tag will be appended to.'
    )
  }

  renderMedia(file, function (tagName) {
    if (tagName === 'video' || tagName === 'audio') return createMedia(tagName)
    else return createElem(tagName)
  }, function (err, elem) {
    if (err && elem) elem.remove()
    cb(err, elem)
  })

  function createMedia (tagName) {
    var elem = createElem(tagName)
    elem.controls = true
    elem.autoplay = true // for chrome
    elem.play() // for firefox
    rootElem.appendChild(elem)
    return elem
  }

  function createElem (tagName) {
    var elem = document.createElement(tagName)
    rootElem.appendChild(elem)
    return elem
  }
}

function renderMedia (file, getElem, cb) {
  var elem
  var extname = path.extname(file.name).toLowerCase()
  var currentTime = 0

  if (MEDIASOURCE_EXTS.indexOf(extname) >= 0) renderMediaSource()
  else if (AUDIO_EXTS.indexOf(extname) >= 0) renderAudio()
  else if (IMAGE_EXTS.indexOf(extname) >= 0) renderImage()
  else if (IFRAME_EXTS.indexOf(extname) >= 0) renderIframe()
  else nextTick(cb, new Error('Unsupported file type "' + extname + '": Cannot append to DOM'))

  function renderMediaSource () {
    if (!MediaSource) {
      return nextTick(cb, new Error(
        'Video/audio streaming is not supported in your browser. You can still share ' +
        'or download ' + file.name + ' (once it\'s fully downloaded). Use Chrome for ' +
        'MediaSource support.'
      ))
    }

    var tagName = MEDIASOURCE_VIDEO_EXTS.indexOf(extname) >= 0 ? 'video' : 'audio'

    if (VIDEOSTREAM_EXTS.indexOf(extname) >= 0) useVideostream()
    else useMediaSource()

    function useVideostream () {
      debug('Use `videostream` package for ' + file.name)
      prepareElem()
      elem.addEventListener('error', fallbackToMediaSource)
      elem.addEventListener('playing', onPlaying)
      videostream(file, elem)
    }

    function useMediaSource () {
      debug('Use MediaSource API for ' + file.name)
      prepareElem()
      elem.addEventListener('error', fallbackToBlobURL)
      elem.addEventListener('playing', onPlaying)

      file.createReadStream().pipe(new MediaSourceStream(elem, { extname: extname }))
      if (currentTime) elem.currentTime = currentTime
    }

    function useBlobURL () {
      debug('Use Blob URL for ' + file.name)
      prepareElem()
      elem.addEventListener('error', fatalError)
      elem.addEventListener('playing', onPlaying)
      getBlobURL(file, function (err, url) {
        if (err) return fatalError(err)
        elem.src = url
        if (currentTime) elem.currentTime = currentTime
      })
    }

    function fallbackToMediaSource (err) {
      debug('videostream error: fallback to MediaSource API: %o', err.message || err)
      elem.removeEventListener('error', fallbackToMediaSource)
      elem.removeEventListener('playing', onPlaying)

      useMediaSource()
    }

    function fallbackToBlobURL (err) {
      debug('MediaSource API error: fallback to Blob URL: %o', err.message || err)
      elem.removeEventListener('error', fallbackToBlobURL)
      elem.removeEventListener('playing', onPlaying)

      useBlobURL()
    }

    function prepareElem () {
      if (!elem) {
        elem = getElem(tagName)

        elem.addEventListener('progress', function () {
          currentTime = elem.currentTime
        })
      }
    }
  }

  function onPlaying () {
    elem.removeEventListener('playing', onPlaying)
    cb(null, elem)
  }

  function renderAudio () {
    elem = getElem('audio')
    getBlobURL(file, function (err, url) {
      if (err) return fatalError(err)
      elem.addEventListener('error', fatalError)
      elem.addEventListener('playing', onPlaying)
      elem.src = url
    })
  }

  function renderImage () {
    elem = getElem('img')
    getBlobURL(file, function (err, url) {
      if (err) return fatalError(err)
      elem.src = url
      elem.alt = file.name
      cb(null, elem)
    })
  }

  function renderIframe () {
    elem = getElem('iframe')

    getBlobURL(file, function (err, url) {
      if (err) return fatalError(err)
      elem.src = url
      if (extname !== '.pdf') elem.sandbox = 'allow-forms allow-scripts'
      cb(null, elem)
    })
  }

  function fatalError (err) {
    err.message = 'Error rendering file "' + file.name + '": ' + err.message
    debug(err.message)
    if (cb) cb(err)
  }
}

function nextTick (cb, err, val) {
  process.nextTick(function () {
    if (cb) cb(err, val)
  })
}

function getBlobURL (file, cb) {
  var ext = path.extname(file.name).toLowerCase()
  streamToBlobURL(file.createReadStream(), file.length, mime[ext], cb)
}

function validateFile (file) {
  if (file == null) {
    throw new Error('file cannot be null or undefined')
  }
  if (typeof file.name !== 'string') {
    throw new Error('missing or invalid file.name property')
  }
  if (typeof file.length !== 'number') {
    throw new Error('missing or invalid file.length property')
  }
  if (typeof file.createReadStream !== 'function') {
    throw new Error('missing or invalid file.createReadStream property')
  }
}

}).call(this,require('_process'))
},{"./lib/mime":137,"_process":33,"debug":93,"mediasource":102,"path":32,"stream-to-blob-url":150,"videostream":171}],137:[function(require,module,exports){
module.exports={
  ".3gp": "video/3gpp",
  ".aac": "audio/aac",
  ".aif": "audio/x-aiff",
  ".aiff": "audio/x-aiff",
  ".atom": "application/atom+xml",
  ".avi": "video/x-msvideo",
  ".bmp": "image/bmp",
  ".bz2": "application/x-bzip2",
  ".conf": "text/plain",
  ".css": "text/css",
  ".csv": "text/csv",
  ".diff": "text/x-diff",
  ".doc": "application/msword",
  ".flv": "video/x-flv",
  ".gif": "image/gif",
  ".gz": "application/x-gzip",
  ".htm": "text/html",
  ".html": "text/html",
  ".ico": "image/vnd.microsoft.icon",
  ".ics": "text/calendar",
  ".iso": "application/octet-stream",
  ".jar": "application/java-archive",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".json": "application/json",
  ".less": "text/css",
  ".log": "text/plain",
  ".m3u": "audio/x-mpegurl",
  ".m4a": "audio/mp4",
  ".m4v": "video/mp4",
  ".manifest": "text/cache-manifest",
  ".markdown": "text/x-markdown",
  ".mathml": "application/mathml+xml",
  ".md": "text/x-markdown",
  ".mid": "audio/midi",
  ".midi": "audio/midi",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mp4v": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".oga": "audio/ogg",
  ".ogg": "application/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pps": "application/vnd.ms-powerpoint",
  ".ppt": "application/vnd.ms-powerpoint",
  ".ps": "application/postscript",
  ".psd": "image/vnd.adobe.photoshop",
  ".qt": "video/quicktime",
  ".rar": "application/x-rar-compressed",
  ".rdf": "application/rdf+xml",
  ".rss": "application/rss+xml",
  ".rtf": "application/rtf",
  ".svg": "image/svg+xml",
  ".svgz": "image/svg+xml",
  ".swf": "application/x-shockwave-flash",
  ".tar": "application/x-tar",
  ".tbz": "application/x-bzip-compressed-tar",
  ".text": "text/plain",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".torrent": "application/x-bittorrent",
  ".ttf": "application/x-font-ttf",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".wma": "audio/x-ms-wma",
  ".wmv": "video/x-ms-wmv",
  ".xls": "application/vnd.ms-excel",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".zip": "application/zip"
}

},{}],138:[function(require,module,exports){
(function (process){
module.exports = function (tasks, limit, cb) {
  if (typeof limit !== 'number') throw new Error('second argument must be a Number')
  var results, len, pending, keys, isErrored
  var isSync = true

  if (Array.isArray(tasks)) {
    results = []
    pending = len = tasks.length
  } else {
    keys = Object.keys(tasks)
    results = {}
    pending = len = keys.length
  }

  function done (err) {
    function end () {
      if (cb) cb(err, results)
      cb = null
    }
    if (isSync) process.nextTick(end)
    else end()
  }

  function each (i, err, result) {
    results[i] = result
    if (err) isErrored = true
    if (--pending === 0 || err) {
      done(err)
    } else if (!isErrored && next < len) {
      var key
      if (keys) {
        key = keys[next]
        next += 1
        tasks[key](each.bind(undefined, key))
      } else {
        key = next
        next += 1
        tasks[key](each.bind(undefined, key))
      }
    }
  }

  var next = limit
  if (!pending) {
    // empty
    done(null)
  } else if (keys) {
    // object
    keys.some(function (key, i) {
      tasks[key](each.bind(undefined, key))
      if (i === limit - 1) return true // early return
    })
  } else {
    // array
    tasks.some(function (task, i) {
      task(each.bind(undefined, i))
      if (i === limit - 1) return true // early return
    })
  }

  isSync = false
}

}).call(this,require('_process'))
},{"_process":33}],139:[function(require,module,exports){
(function (process){
module.exports = function (tasks, cb) {
  var results, pending, keys
  var isSync = true

  if (Array.isArray(tasks)) {
    results = []
    pending = tasks.length
  } else {
    keys = Object.keys(tasks)
    results = {}
    pending = keys.length
  }

  function done (err) {
    function end () {
      if (cb) cb(err, results)
      cb = null
    }
    if (isSync) process.nextTick(end)
    else end()
  }

  function each (i, err, result) {
    results[i] = result
    if (--pending === 0 || err) {
      done(err)
    }
  }

  if (!pending) {
    // empty
    done(null)
  } else if (keys) {
    // object
    keys.forEach(function (key) {
      tasks[key](each.bind(undefined, key))
    })
  } else {
    // array
    tasks.forEach(function (task, i) {
      task(each.bind(undefined, i))
    })
  }

  isSync = false
}

}).call(this,require('_process'))
},{"_process":33}],140:[function(require,module,exports){
(function (Buffer){
module.exports = simpleGet

var extend = require('xtend')
var http = require('http')
var https = require('https')
var once = require('once')
var unzipResponse = require('unzip-response') // excluded from browser build
var url = require('url')

function simpleGet (opts, cb) {
  opts = typeof opts === 'string' ? { url: opts } : extend(opts)
  cb = once(cb)

  if (opts.url) parseOptsUrl(opts)
  if (opts.headers == null) opts.headers = {}
  if (opts.maxRedirects == null) opts.maxRedirects = 10

  var body = opts.body
  opts.body = undefined
  if (body && !opts.method) opts.method = 'POST'

  // Request gzip/deflate
  var customAcceptEncoding = Object.keys(opts.headers).some(function (h) {
    return h.toLowerCase() === 'accept-encoding'
  })
  if (!customAcceptEncoding) opts.headers['accept-encoding'] = 'gzip, deflate'

  // Support http: and https: urls
  var protocol = opts.protocol === 'https:' ? https : http
  var req = protocol.request(opts, function (res) {
    // Follow 3xx redirects
    if (res.statusCode >= 300 && res.statusCode < 400 && 'location' in res.headers) {
      opts.url = res.headers.location
      parseOptsUrl(opts)
      res.resume() // Discard response

      opts.maxRedirects -= 1
      if (opts.maxRedirects > 0) simpleGet(opts, cb)
      else cb(new Error('too many redirects'))

      return
    }

    cb(null, typeof unzipResponse === 'function' ? unzipResponse(res) : res)
  })
  req.on('error', cb)
  req.end(body)
  return req
}

module.exports.concat = function (opts, cb) {
  return simpleGet(opts, function (err, res) {
    if (err) return cb(err)
    var chunks = []
    res.on('data', function (chunk) {
      chunks.push(chunk)
    })
    res.on('end', function () {
      cb(null, res, Buffer.concat(chunks))
    })
  })
}

;['get', 'post', 'put', 'patch', 'head', 'delete'].forEach(function (method) {
  module.exports[method] = function (opts, cb) {
    if (typeof opts === 'string') opts = { url: opts }
    opts.method = method.toUpperCase()
    return simpleGet(opts, cb)
  }
})

function parseOptsUrl (opts) {
  var loc = url.parse(opts.url)
  if (loc.hostname) opts.hostname = loc.hostname
  if (loc.port) opts.port = loc.port
  if (loc.protocol) opts.protocol = loc.protocol
  opts.path = loc.path
  delete opts.url
}

}).call(this,require("buffer").Buffer)
},{"buffer":25,"http":39,"https":30,"once":142,"unzip-response":24,"url":45,"xtend":172}],141:[function(require,module,exports){
arguments[4][20][0].apply(exports,arguments)
},{"dup":20}],142:[function(require,module,exports){
arguments[4][21][0].apply(exports,arguments)
},{"dup":21,"wrappy":141}],143:[function(require,module,exports){
(function (Buffer){
module.exports = Peer

var debug = require('debug')('simple-peer')
var getBrowserRTC = require('get-browser-rtc')
var hat = require('hat')
var inherits = require('inherits')
var once = require('once')
var stream = require('stream')

inherits(Peer, stream.Duplex)

/**
 * WebRTC peer connection. Same API as node core `net.Socket`, plus a few extra methods.
 * Duplex stream.
 * @param {Object} opts
 */
function Peer (opts) {
  var self = this
  if (!(self instanceof Peer)) return new Peer(opts)
  self._debug('new peer %o', opts)

  if (!opts) opts = {}
  opts.allowHalfOpen = false
  if (opts.highWaterMark == null) opts.highWaterMark = 1024 * 1024

  stream.Duplex.call(self, opts)

  self.initiator = opts.initiator || false
  self.channelConfig = opts.channelConfig || Peer.channelConfig
  self.channelName = opts.initiator ? (opts.channelName || hat(160)) : null
  self.config = opts.config || Peer.config
  self.constraints = opts.constraints || Peer.constraints
  self.offerConstraints = opts.offerConstraints
  self.answerConstraints = opts.answerConstraints
  self.reconnectTimer = opts.reconnectTimer || false
  self.sdpTransform = opts.sdpTransform || function (sdp) { return sdp }
  self.stream = opts.stream || false
  self.trickle = opts.trickle !== undefined ? opts.trickle : true

  self.destroyed = false
  self.connected = false

  // so Peer object always has same shape (V8 optimization)
  self.remoteAddress = undefined
  self.remoteFamily = undefined
  self.remotePort = undefined
  self.localAddress = undefined
  self.localPort = undefined

  self._isWrtc = !!opts.wrtc // HACK: to fix `wrtc` bug. See issue: #60
  self._wrtc = opts.wrtc || getBrowserRTC()
  if (!self._wrtc) {
    if (typeof window === 'undefined') {
      throw new Error('No WebRTC support: Specify `opts.wrtc` option in this environment')
    } else {
      throw new Error('No WebRTC support: Not a supported browser')
    }
  }

  self._maxBufferedAmount = opts.highWaterMark
  self._pcReady = false
  self._channelReady = false
  self._iceComplete = false // ice candidate trickle done (got null candidate)
  self._channel = null
  self._pendingCandidates = []

  self._chunk = null
  self._cb = null
  self._interval = null
  self._reconnectTimeout = null

  self._pc = new (self._wrtc.RTCPeerConnection)(self.config, self.constraints)
  self._pc.oniceconnectionstatechange = self._onIceConnectionStateChange.bind(self)
  self._pc.onsignalingstatechange = self._onSignalingStateChange.bind(self)
  self._pc.onicecandidate = self._onIceCandidate.bind(self)

  if (self.stream) self._pc.addStream(self.stream)
  self._pc.onaddstream = self._onAddStream.bind(self)

  if (self.initiator) {
    self._setupData({ channel: self._pc.createDataChannel(self.channelName, self.channelConfig) })
    self._pc.onnegotiationneeded = once(self._createOffer.bind(self))
    // Only Chrome triggers "negotiationneeded"; this is a workaround for other
    // implementations
    if (typeof window === 'undefined' || !window.webkitRTCPeerConnection) {
      self._pc.onnegotiationneeded()
    }
  } else {
    self._pc.ondatachannel = self._setupData.bind(self)
  }

  self.on('finish', function () {
    if (self.connected) {
      // When local peer is finished writing, close connection to remote peer.
      // Half open connections are currently not supported.
      // Wait a bit before destroying so the datachannel flushes.
      // TODO: is there a more reliable way to accomplish this?
      setTimeout(function () {
        self._destroy()
      }, 100)
    } else {
      // If data channel is not connected when local peer is finished writing, wait until
      // data is flushed to network at "connect" event.
      // TODO: is there a more reliable way to accomplish this?
      self.once('connect', function () {
        setTimeout(function () {
          self._destroy()
        }, 100)
      })
    }
  })
}

Peer.WEBRTC_SUPPORT = !!getBrowserRTC()

/**
 * Expose config, constraints, and data channel config for overriding all Peer
 * instances. Otherwise, just set opts.config, opts.constraints, or opts.channelConfig
 * when constructing a Peer.
 */
Peer.config = {
  iceServers: [
    {
      url: 'stun:23.21.150.121', // deprecated, replaced by `urls`
      urls: 'stun:23.21.150.121'
    }
  ]
}
Peer.constraints = {}
Peer.channelConfig = {}

Object.defineProperty(Peer.prototype, 'bufferSize', {
  get: function () {
    var self = this
    return (self._channel && self._channel.bufferedAmount) || 0
  }
})

Peer.prototype.address = function () {
  var self = this
  return { port: self.localPort, family: 'IPv4', address: self.localAddress }
}

Peer.prototype.signal = function (data) {
  var self = this
  if (self.destroyed) throw new Error('cannot signal after peer is destroyed')
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch (err) {
      data = {}
    }
  }
  self._debug('signal()')

  function addIceCandidate (candidate) {
    try {
      self._pc.addIceCandidate(
        new self._wrtc.RTCIceCandidate(candidate), noop, self._onError.bind(self)
      )
    } catch (err) {
      self._destroy(new Error('error adding candidate: ' + err.message))
    }
  }

  if (data.sdp) {
    self._pc.setRemoteDescription(new (self._wrtc.RTCSessionDescription)(data), function () {
      if (self.destroyed) return
      if (self._pc.remoteDescription.type === 'offer') self._createAnswer()

      self._pendingCandidates.forEach(addIceCandidate)
      self._pendingCandidates = []
    }, self._onError.bind(self))
  }
  if (data.candidate) {
    if (self._pc.remoteDescription) addIceCandidate(data.candidate)
    else self._pendingCandidates.push(data.candidate)
  }
  if (!data.sdp && !data.candidate) {
    self._destroy(new Error('signal() called with invalid signal data'))
  }
}

/**
 * Send text/binary data to the remote peer.
 * @param {TypedArrayView|ArrayBuffer|Buffer|string|Blob|Object} chunk
 */
Peer.prototype.send = function (chunk) {
  var self = this

  // HACK: `wrtc` module doesn't accept node.js buffer. See issue: #60
  if (Buffer.isBuffer(chunk) && self._isWrtc) {
    chunk = new Uint8Array(chunk)
  }

  var len = chunk.length || chunk.byteLength || chunk.size
  self._channel.send(chunk)
  self._debug('write: %d bytes', len)
}

Peer.prototype.destroy = function (onclose) {
  var self = this
  self._destroy(null, onclose)
}

Peer.prototype._destroy = function (err, onclose) {
  var self = this
  if (self.destroyed) return
  if (onclose) self.once('close', onclose)

  self._debug('destroy (error: %s)', err && err.message)

  self.readable = self.writable = false

  if (!self._readableState.ended) self.push(null)
  if (!self._writableState.finished) self.end()

  self.destroyed = true
  self.connected = false
  self._pcReady = false
  self._channelReady = false

  self._chunk = null
  self._cb = null
  clearInterval(self._interval)
  clearTimeout(self._reconnectTimeout)

  if (self._pc) {
    try {
      self._pc.close()
    } catch (err) {}

    self._pc.oniceconnectionstatechange = null
    self._pc.onsignalingstatechange = null
    self._pc.onicecandidate = null
  }

  if (self._channel) {
    try {
      self._channel.close()
    } catch (err) {}

    self._channel.onmessage = null
    self._channel.onopen = null
    self._channel.onclose = null
  }
  self._pc = null
  self._channel = null

  if (err) self.emit('error', err)
  self.emit('close')
}

Peer.prototype._setupData = function (event) {
  var self = this
  self._channel = event.channel
  self.channelName = self._channel.label

  self._channel.binaryType = 'arraybuffer'
  self._channel.onmessage = self._onChannelMessage.bind(self)
  self._channel.onopen = self._onChannelOpen.bind(self)
  self._channel.onclose = self._onChannelClose.bind(self)
}

Peer.prototype._read = function () {}

Peer.prototype._write = function (chunk, encoding, cb) {
  var self = this
  if (self.destroyed) return cb(new Error('cannot write after peer is destroyed'))

  if (self.connected) {
    try {
      self.send(chunk)
    } catch (err) {
      return self._onError(err)
    }
    if (self._channel.bufferedAmount > self._maxBufferedAmount) {
      self._debug('start backpressure: bufferedAmount %d', self._channel.bufferedAmount)
      self._cb = cb
    } else {
      cb(null)
    }
  } else {
    self._debug('write before connect')
    self._chunk = chunk
    self._cb = cb
  }
}

Peer.prototype._createOffer = function () {
  var self = this
  if (self.destroyed) return

  self._pc.createOffer(function (offer) {
    if (self.destroyed) return
    offer.sdp = self.sdpTransform(offer.sdp)
    self._pc.setLocalDescription(offer, noop, self._onError.bind(self))
    var sendOffer = function () {
      var signal = self._pc.localDescription || offer
      self._debug('signal')
      self.emit('signal', {
        type: signal.type,
        sdp: signal.sdp
      })
    }
    if (self.trickle || self._iceComplete) sendOffer()
    else self.once('_iceComplete', sendOffer) // wait for candidates
  }, self._onError.bind(self), self.offerConstraints)
}

Peer.prototype._createAnswer = function () {
  var self = this
  if (self.destroyed) return

  self._pc.createAnswer(function (answer) {
    if (self.destroyed) return
    answer.sdp = self.sdpTransform(answer.sdp)
    self._pc.setLocalDescription(answer, noop, self._onError.bind(self))
    var sendAnswer = function () {
      var signal = self._pc.localDescription || answer
      self._debug('signal')
      self.emit('signal', {
        type: signal.type,
        sdp: signal.sdp
      })
    }
    if (self.trickle || self._iceComplete) sendAnswer()
    else self.once('_iceComplete', sendAnswer)
  }, self._onError.bind(self), self.answerConstraints)
}

Peer.prototype._onIceConnectionStateChange = function () {
  var self = this
  if (self.destroyed) return
  var iceGatheringState = self._pc.iceGatheringState
  var iceConnectionState = self._pc.iceConnectionState
  self._debug('iceConnectionStateChange %s %s', iceGatheringState, iceConnectionState)
  self.emit('iceConnectionStateChange', iceGatheringState, iceConnectionState)
  if (iceConnectionState === 'connected' || iceConnectionState === 'completed') {
    clearTimeout(self._reconnectTimeout)
    self._pcReady = true
    self._maybeReady()
  }
  if (iceConnectionState === 'disconnected') {
    if (self.reconnectTimer) {
      // If user has set `opt.reconnectTimer`, allow time for ICE to attempt a reconnect
      clearTimeout(self._reconnectTimeout)
      self._reconnectTimeout = setTimeout(function () {
        self._destroy()
      }, self.reconnectTimer)
    } else {
      self._destroy()
    }
  }
  if (iceConnectionState === 'failed') {
    self._destroy()
  }
  if (iceConnectionState === 'closed') {
    self._destroy()
  }
}

Peer.prototype.getStats = function (cb) {
  var self = this
  if (!self._pc.getStats) { // No ability to call stats
    cb([])
  } else if (typeof window !== 'undefined' && !!window.mozRTCPeerConnection) { // Mozilla
    self._pc.getStats(null, function (res) {
      var items = []
      res.forEach(function (item) {
        items.push(item)
      })
      cb(items)
    }, self._onError.bind(self))
  } else {
    self._pc.getStats(function (res) { // Chrome
      var items = []
      res.result().forEach(function (result) {
        var item = {}
        result.names().forEach(function (name) {
          item[name] = result.stat(name)
        })
        item.id = result.id
        item.type = result.type
        item.timestamp = result.timestamp
        items.push(item)
      })
      cb(items)
    })
  }
}

Peer.prototype._maybeReady = function () {
  var self = this
  self._debug('maybeReady pc %s channel %s', self._pcReady, self._channelReady)
  if (self.connected || self._connecting || !self._pcReady || !self._channelReady) return
  self._connecting = true

  self.getStats(function (items) {
    self._connecting = false
    self.connected = true

    var remoteCandidates = {}
    var localCandidates = {}

    function setActiveCandidates (item) {
      var local = localCandidates[item.localCandidateId]
      var remote = remoteCandidates[item.remoteCandidateId]

      if (local) {
        self.localAddress = local.ipAddress
        self.localPort = Number(local.portNumber)
      } else if (typeof item.googLocalAddress === 'string') {
        // Sometimes `item.id` is undefined in `wrtc` and Chrome
        // See: https://github.com/feross/simple-peer/issues/66
        local = item.googLocalAddress.split(':')
        self.localAddress = local[0]
        self.localPort = Number(local[1])
      }
      self._debug('connect local: %s:%s', self.localAddress, self.localPort)

      if (remote) {
        self.remoteAddress = remote.ipAddress
        self.remotePort = Number(remote.portNumber)
        self.remoteFamily = 'IPv4'
      } else if (typeof item.googRemoteAddress === 'string') {
        remote = item.googRemoteAddress.split(':')
        self.remoteAddress = remote[0]
        self.remotePort = Number(remote[1])
        self.remoteFamily = 'IPv4'
      }
      self._debug('connect remote: %s:%s', self.remoteAddress, self.remotePort)
    }

    items.forEach(function (item) {
      if (item.type === 'remotecandidate') remoteCandidates[item.id] = item
      if (item.type === 'localcandidate') localCandidates[item.id] = item
    })

    items.forEach(function (item) {
      var isCandidatePair = (
        (item.type === 'googCandidatePair' && item.googActiveConnection === 'true') ||
        (item.type === 'candidatepair' && item.selected)
      )
      if (isCandidatePair) setActiveCandidates(item)
    })

    if (self._chunk) {
      try {
        self.send(self._chunk)
      } catch (err) {
        return self._onError(err)
      }
      self._chunk = null
      self._debug('sent chunk from "write before connect"')

      var cb = self._cb
      self._cb = null
      cb(null)
    }

    self._interval = setInterval(function () {
      if (!self._cb || !self._channel || self._channel.bufferedAmount > self._maxBufferedAmount) return
      self._debug('ending backpressure: bufferedAmount %d', self._channel.bufferedAmount)
      var cb = self._cb
      self._cb = null
      cb(null)
    }, 150)
    if (self._interval.unref) self._interval.unref()

    self._debug('connect')
    self.emit('connect')
  })
}

Peer.prototype._onSignalingStateChange = function () {
  var self = this
  if (self.destroyed) return
  self._debug('signalingStateChange %s', self._pc.signalingState)
  self.emit('signalingStateChange', self._pc.signalingState)
}

Peer.prototype._onIceCandidate = function (event) {
  var self = this
  if (self.destroyed) return
  if (event.candidate && self.trickle) {
    self.emit('signal', {
      candidate: {
        candidate: event.candidate.candidate,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        sdpMid: event.candidate.sdpMid
      }
    })
  } else if (!event.candidate) {
    self._iceComplete = true
    self.emit('_iceComplete')
  }
}

Peer.prototype._onChannelMessage = function (event) {
  var self = this
  if (self.destroyed) return
  var data = event.data
  self._debug('read: %d bytes', data.byteLength || data.length)

  if (data instanceof ArrayBuffer) data = new Buffer(data)
  self.push(data)
}

Peer.prototype._onChannelOpen = function () {
  var self = this
  if (self.connected || self.destroyed) return
  self._debug('on channel open')
  self._channelReady = true
  self._maybeReady()
}

Peer.prototype._onChannelClose = function () {
  var self = this
  if (self.destroyed) return
  self._debug('on channel close')
  self._destroy()
}

Peer.prototype._onAddStream = function (event) {
  var self = this
  if (self.destroyed) return
  self._debug('on add stream')
  self.emit('stream', event.stream)
}

Peer.prototype._onError = function (err) {
  var self = this
  if (self.destroyed) return
  self._debug('error %s', err.message || err)
  self._destroy(err)
}

Peer.prototype._debug = function () {
  var self = this
  var args = [].slice.call(arguments)
  var id = self.channelName && self.channelName.substring(0, 7)
  args[0] = '[' + id + '] ' + args[0]
  debug.apply(null, args)
}

function noop () {}

}).call(this,require("buffer").Buffer)
},{"buffer":25,"debug":93,"get-browser-rtc":144,"hat":99,"inherits":101,"once":146,"stream":38}],144:[function(require,module,exports){
// originally pulled out of simple-peer

module.exports = function getBrowserRTC () {
  if (typeof window === 'undefined') return null
  var wrtc = {
    RTCPeerConnection: window.RTCPeerConnection || window.mozRTCPeerConnection ||
      window.webkitRTCPeerConnection,
    RTCSessionDescription: window.RTCSessionDescription ||
      window.mozRTCSessionDescription || window.webkitRTCSessionDescription,
    RTCIceCandidate: window.RTCIceCandidate || window.mozRTCIceCandidate ||
      window.webkitRTCIceCandidate
  }
  if (!wrtc.RTCPeerConnection) return null
  return wrtc
}

},{}],145:[function(require,module,exports){
arguments[4][20][0].apply(exports,arguments)
},{"dup":20}],146:[function(require,module,exports){
arguments[4][21][0].apply(exports,arguments)
},{"dup":21,"wrappy":145}],147:[function(require,module,exports){
var Rusha = require('rusha')

var rusha = new Rusha
var crypto = window.crypto || window.msCrypto || {}
var subtle = crypto.subtle || crypto.webkitSubtle
var sha1sync = rusha.digest.bind(rusha)

// Browsers throw if they lack support for an algorithm.
// Promise will be rejected on non-secure origins. (http://goo.gl/lq4gCo)
try {
  subtle.digest({ name: 'sha-1' }, new Uint8Array).catch(function () {
    subtle = false
  })
} catch (err) { subtle = false }

function sha1 (buf, cb) {
  if (!subtle) {
    // Use Rusha
    setTimeout(cb, 0, sha1sync(buf))
    return
  }

  if (typeof buf === 'string') {
    buf = uint8array(buf)
  }

  subtle.digest({ name: 'sha-1' }, buf)
    .then(function succeed (result) {
      cb(hex(new Uint8Array(result)))
    },
    function fail (error) {
      cb(sha1sync(buf))
    })
}

function uint8array (s) {
  var l = s.length
  var array = new Uint8Array(l)
  for (var i = 0; i < l; i++) {
    array[i] = s.charCodeAt(i)
  }
  return array
}

function hex (buf) {
  var l = buf.length
  var chars = []
  for (var i = 0; i < l; i++) {
    var bite = buf[i]
    chars.push((bite >>> 4).toString(16))
    chars.push((bite & 0x0f).toString(16))
  }
  return chars.join('')
}

module.exports = sha1
module.exports.sync = sha1sync

},{"rusha":148}],148:[function(require,module,exports){
(function (global){
/*
 * Rusha, a JavaScript implementation of the Secure Hash Algorithm, SHA-1,
 * as defined in FIPS PUB 180-1, tuned for high performance with large inputs.
 * (http://github.com/srijs/rusha)
 *
 * Inspired by Paul Johnstons implementation (http://pajhome.org.uk/crypt/md5).
 *
 * Copyright (c) 2013 Sam Rijs (http://awesam.de).
 * Released under the terms of the MIT license as follows:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
(function () {
    var util = {
            getDataType: function (data) {
                if (typeof data === 'string') {
                    return 'string';
                }
                if (data instanceof Array) {
                    return 'array';
                }
                if (typeof global !== 'undefined' && global.Buffer && global.Buffer.isBuffer(data)) {
                    return 'buffer';
                }
                if (data instanceof ArrayBuffer) {
                    return 'arraybuffer';
                }
                if (data.buffer instanceof ArrayBuffer) {
                    return 'view';
                }
                if (data instanceof Blob) {
                    return 'blob';
                }
                throw new Error('Unsupported data type.');
            }
        };
    // The Rusha object is a wrapper around the low-level RushaCore.
    // It provides means of converting different inputs to the
    // format accepted by RushaCore as well as other utility methods.
    function Rusha(chunkSize) {
        'use strict';
        // Private object structure.
        var self$2 = { fill: 0 };
        // Calculate the length of buffer that the sha1 routine uses
        // including the padding.
        var padlen = function (len) {
            for (len += 9; len % 64 > 0; len += 1);
            return len;
        };
        var padZeroes = function (bin, len) {
            for (var i = len >> 2; i < bin.length; i++)
                bin[i] = 0;
        };
        var padData = function (bin, chunkLen, msgLen) {
            bin[chunkLen >> 2] |= 128 << 24 - (chunkLen % 4 << 3);
            bin[((chunkLen >> 2) + 2 & ~15) + 14] = msgLen >> 29;
            bin[((chunkLen >> 2) + 2 & ~15) + 15] = msgLen << 3;
        };
        // Convert a binary string and write it to the heap.
        // A binary string is expected to only contain char codes < 256.
        var convStr = function (H8, H32, start, len, off) {
            var str = this, i, om = off % 4, lm = len % 4, j = len - lm;
            if (j > 0) {
                switch (om) {
                case 0:
                    H8[off + 3 | 0] = str.charCodeAt(start);
                case 1:
                    H8[off + 2 | 0] = str.charCodeAt(start + 1);
                case 2:
                    H8[off + 1 | 0] = str.charCodeAt(start + 2);
                case 3:
                    H8[off | 0] = str.charCodeAt(start + 3);
                }
            }
            for (i = om; i < j; i = i + 4 | 0) {
                H32[off + i >> 2] = str.charCodeAt(start + i) << 24 | str.charCodeAt(start + i + 1) << 16 | str.charCodeAt(start + i + 2) << 8 | str.charCodeAt(start + i + 3);
            }
            switch (lm) {
            case 3:
                H8[off + j + 1 | 0] = str.charCodeAt(start + j + 2);
            case 2:
                H8[off + j + 2 | 0] = str.charCodeAt(start + j + 1);
            case 1:
                H8[off + j + 3 | 0] = str.charCodeAt(start + j);
            }
        };
        // Convert a buffer or array and write it to the heap.
        // The buffer or array is expected to only contain elements < 256.
        var convBuf = function (H8, H32, start, len, off) {
            var buf = this, i, om = off % 4, lm = len % 4, j = len - lm;
            if (j > 0) {
                switch (om) {
                case 0:
                    H8[off + 3 | 0] = buf[start];
                case 1:
                    H8[off + 2 | 0] = buf[start + 1];
                case 2:
                    H8[off + 1 | 0] = buf[start + 2];
                case 3:
                    H8[off | 0] = buf[start + 3];
                }
            }
            for (i = 4 - om; i < j; i = i += 4 | 0) {
                H32[off + i >> 2] = buf[start + i] << 24 | buf[start + i + 1] << 16 | buf[start + i + 2] << 8 | buf[start + i + 3];
            }
            switch (lm) {
            case 3:
                H8[off + j + 1 | 0] = buf[start + j + 2];
            case 2:
                H8[off + j + 2 | 0] = buf[start + j + 1];
            case 1:
                H8[off + j + 3 | 0] = buf[start + j];
            }
        };
        var convBlob = function (H8, H32, start, len, off) {
            var blob = this, i, om = off % 4, lm = len % 4, j = len - lm;
            var buf = new Uint8Array(reader.readAsArrayBuffer(blob.slice(start, start + len)));
            if (j > 0) {
                switch (om) {
                case 0:
                    H8[off + 3 | 0] = buf[0];
                case 1:
                    H8[off + 2 | 0] = buf[1];
                case 2:
                    H8[off + 1 | 0] = buf[2];
                case 3:
                    H8[off | 0] = buf[3];
                }
            }
            for (i = 4 - om; i < j; i = i += 4 | 0) {
                H32[off + i >> 2] = buf[i] << 24 | buf[i + 1] << 16 | buf[i + 2] << 8 | buf[i + 3];
            }
            switch (lm) {
            case 3:
                H8[off + j + 1 | 0] = buf[j + 2];
            case 2:
                H8[off + j + 2 | 0] = buf[j + 1];
            case 1:
                H8[off + j + 3 | 0] = buf[j];
            }
        };
        var convFn = function (data) {
            switch (util.getDataType(data)) {
            case 'string':
                return convStr.bind(data);
            case 'array':
                return convBuf.bind(data);
            case 'buffer':
                return convBuf.bind(data);
            case 'arraybuffer':
                return convBuf.bind(new Uint8Array(data));
            case 'view':
                return convBuf.bind(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            case 'blob':
                return convBlob.bind(data);
            }
        };
        var slice = function (data, offset) {
            switch (util.getDataType(data)) {
            case 'string':
                return data.slice(offset);
            case 'array':
                return data.slice(offset);
            case 'buffer':
                return data.slice(offset);
            case 'arraybuffer':
                return data.slice(offset);
            case 'view':
                return data.buffer.slice(offset);
            }
        };
        // Convert an ArrayBuffer into its hexadecimal string representation.
        var hex = function (arrayBuffer) {
            var i, x, hex_tab = '0123456789abcdef', res = [], binarray = new Uint8Array(arrayBuffer);
            for (i = 0; i < binarray.length; i++) {
                x = binarray[i];
                res[i] = hex_tab.charAt(x >> 4 & 15) + hex_tab.charAt(x >> 0 & 15);
            }
            return res.join('');
        };
        var ceilHeapSize = function (v) {
            // The asm.js spec says:
            // The heap object's byteLength must be either
            // 2^n for n in [12, 24) or 2^24 * n for n ≥ 1.
            // Also, byteLengths smaller than 2^16 are deprecated.
            var p;
            // If v is smaller than 2^16, the smallest possible solution
            // is 2^16.
            if (v <= 65536)
                return 65536;
            // If v < 2^24, we round up to 2^n,
            // otherwise we round up to 2^24 * n.
            if (v < 16777216) {
                for (p = 1; p < v; p = p << 1);
            } else {
                for (p = 16777216; p < v; p += 16777216);
            }
            return p;
        };
        // Initialize the internal data structures to a new capacity.
        var init = function (size) {
            if (size % 64 > 0) {
                throw new Error('Chunk size must be a multiple of 128 bit');
            }
            self$2.maxChunkLen = size;
            self$2.padMaxChunkLen = padlen(size);
            // The size of the heap is the sum of:
            // 1. The padded input message size
            // 2. The extended space the algorithm needs (320 byte)
            // 3. The 160 bit state the algoritm uses
            self$2.heap = new ArrayBuffer(ceilHeapSize(self$2.padMaxChunkLen + 320 + 20));
            self$2.h32 = new Int32Array(self$2.heap);
            self$2.h8 = new Int8Array(self$2.heap);
            self$2.core = new Rusha._core({
                Int32Array: Int32Array,
                DataView: DataView
            }, {}, self$2.heap);
            self$2.buffer = null;
        };
        // Iinitializethe datastructures according
        // to a chunk siyze.
        init(chunkSize || 64 * 1024);
        var initState = function (heap, padMsgLen) {
            var io = new Int32Array(heap, padMsgLen + 320, 5);
            io[0] = 1732584193;
            io[1] = -271733879;
            io[2] = -1732584194;
            io[3] = 271733878;
            io[4] = -1009589776;
        };
        var padChunk = function (chunkLen, msgLen) {
            var padChunkLen = padlen(chunkLen);
            var view = new Int32Array(self$2.heap, 0, padChunkLen >> 2);
            padZeroes(view, chunkLen);
            padData(view, chunkLen, msgLen);
            return padChunkLen;
        };
        // Write data to the heap.
        var write = function (data, chunkOffset, chunkLen) {
            convFn(data)(self$2.h8, self$2.h32, chunkOffset, chunkLen, 0);
        };
        // Initialize and call the RushaCore,
        // assuming an input buffer of length len * 4.
        var coreCall = function (data, chunkOffset, chunkLen, msgLen, finalize) {
            var padChunkLen = chunkLen;
            if (finalize) {
                padChunkLen = padChunk(chunkLen, msgLen);
            }
            write(data, chunkOffset, chunkLen);
            self$2.core.hash(padChunkLen, self$2.padMaxChunkLen);
        };
        var getRawDigest = function (heap, padMaxChunkLen) {
            var io = new Int32Array(heap, padMaxChunkLen + 320, 5);
            var out = new Int32Array(5);
            var arr = new DataView(out.buffer);
            arr.setInt32(0, io[0], false);
            arr.setInt32(4, io[1], false);
            arr.setInt32(8, io[2], false);
            arr.setInt32(12, io[3], false);
            arr.setInt32(16, io[4], false);
            return out;
        };
        // Calculate the hash digest as an array of 5 32bit integers.
        var rawDigest = this.rawDigest = function (str) {
                var msgLen = str.byteLength || str.length || str.size || 0;
                initState(self$2.heap, self$2.padMaxChunkLen);
                var chunkOffset = 0, chunkLen = self$2.maxChunkLen, last;
                for (chunkOffset = 0; msgLen > chunkOffset + chunkLen; chunkOffset += chunkLen) {
                    coreCall(str, chunkOffset, chunkLen, msgLen, false);
                }
                coreCall(str, chunkOffset, msgLen - chunkOffset, msgLen, true);
                return getRawDigest(self$2.heap, self$2.padMaxChunkLen);
            };
        // The digest and digestFrom* interface returns the hash digest
        // as a hex string.
        this.digest = this.digestFromString = this.digestFromBuffer = this.digestFromArrayBuffer = function (str) {
            return hex(rawDigest(str).buffer);
        };
    }
    ;
    // The low-level RushCore module provides the heart of Rusha,
    // a high-speed sha1 implementation working on an Int32Array heap.
    // At first glance, the implementation seems complicated, however
    // with the SHA1 spec at hand, it is obvious this almost a textbook
    // implementation that has a few functions hand-inlined and a few loops
    // hand-unrolled.
    Rusha._core = function RushaCore(stdlib, foreign, heap) {
        'use asm';
        var H = new stdlib.Int32Array(heap);
        function hash(k, x) {
            // k in bytes
            k = k | 0;
            x = x | 0;
            var i = 0, j = 0, y0 = 0, z0 = 0, y1 = 0, z1 = 0, y2 = 0, z2 = 0, y3 = 0, z3 = 0, y4 = 0, z4 = 0, t0 = 0, t1 = 0;
            y0 = H[x + 320 >> 2] | 0;
            y1 = H[x + 324 >> 2] | 0;
            y2 = H[x + 328 >> 2] | 0;
            y3 = H[x + 332 >> 2] | 0;
            y4 = H[x + 336 >> 2] | 0;
            for (i = 0; (i | 0) < (k | 0); i = i + 64 | 0) {
                z0 = y0;
                z1 = y1;
                z2 = y2;
                z3 = y3;
                z4 = y4;
                for (j = 0; (j | 0) < 64; j = j + 4 | 0) {
                    t1 = H[i + j >> 2] | 0;
                    t0 = ((y0 << 5 | y0 >>> 27) + (y1 & y2 | ~y1 & y3) | 0) + ((t1 + y4 | 0) + 1518500249 | 0) | 0;
                    y4 = y3;
                    y3 = y2;
                    y2 = y1 << 30 | y1 >>> 2;
                    y1 = y0;
                    y0 = t0;
                    H[k + j >> 2] = t1;
                }
                for (j = k + 64 | 0; (j | 0) < (k + 80 | 0); j = j + 4 | 0) {
                    t1 = (H[j - 12 >> 2] ^ H[j - 32 >> 2] ^ H[j - 56 >> 2] ^ H[j - 64 >> 2]) << 1 | (H[j - 12 >> 2] ^ H[j - 32 >> 2] ^ H[j - 56 >> 2] ^ H[j - 64 >> 2]) >>> 31;
                    t0 = ((y0 << 5 | y0 >>> 27) + (y1 & y2 | ~y1 & y3) | 0) + ((t1 + y4 | 0) + 1518500249 | 0) | 0;
                    y4 = y3;
                    y3 = y2;
                    y2 = y1 << 30 | y1 >>> 2;
                    y1 = y0;
                    y0 = t0;
                    H[j >> 2] = t1;
                }
                for (j = k + 80 | 0; (j | 0) < (k + 160 | 0); j = j + 4 | 0) {
                    t1 = (H[j - 12 >> 2] ^ H[j - 32 >> 2] ^ H[j - 56 >> 2] ^ H[j - 64 >> 2]) << 1 | (H[j - 12 >> 2] ^ H[j - 32 >> 2] ^ H[j - 56 >> 2] ^ H[j - 64 >> 2]) >>> 31;
                    t0 = ((y0 << 5 | y0 >>> 27) + (y1 ^ y2 ^ y3) | 0) + ((t1 + y4 | 0) + 1859775393 | 0) | 0;
                    y4 = y3;
                    y3 = y2;
                    y2 = y1 << 30 | y1 >>> 2;
                    y1 = y0;
                    y0 = t0;
                    H[j >> 2] = t1;
                }
                for (j = k + 160 | 0; (j | 0) < (k + 240 | 0); j = j + 4 | 0) {
                    t1 = (H[j - 12 >> 2] ^ H[j - 32 >> 2] ^ H[j - 56 >> 2] ^ H[j - 64 >> 2]) << 1 | (H[j - 12 >> 2] ^ H[j - 32 >> 2] ^ H[j - 56 >> 2] ^ H[j - 64 >> 2]) >>> 31;
                    t0 = ((y0 << 5 | y0 >>> 27) + (y1 & y2 | y1 & y3 | y2 & y3) | 0) + ((t1 + y4 | 0) - 1894007588 | 0) | 0;
                    y4 = y3;
                    y3 = y2;
                    y2 = y1 << 30 | y1 >>> 2;
                    y1 = y0;
                    y0 = t0;
                    H[j >> 2] = t1;
                }
                for (j = k + 240 | 0; (j | 0) < (k + 320 | 0); j = j + 4 | 0) {
                    t1 = (H[j - 12 >> 2] ^ H[j - 32 >> 2] ^ H[j - 56 >> 2] ^ H[j - 64 >> 2]) << 1 | (H[j - 12 >> 2] ^ H[j - 32 >> 2] ^ H[j - 56 >> 2] ^ H[j - 64 >> 2]) >>> 31;
                    t0 = ((y0 << 5 | y0 >>> 27) + (y1 ^ y2 ^ y3) | 0) + ((t1 + y4 | 0) - 899497514 | 0) | 0;
                    y4 = y3;
                    y3 = y2;
                    y2 = y1 << 30 | y1 >>> 2;
                    y1 = y0;
                    y0 = t0;
                    H[j >> 2] = t1;
                }
                y0 = y0 + z0 | 0;
                y1 = y1 + z1 | 0;
                y2 = y2 + z2 | 0;
                y3 = y3 + z3 | 0;
                y4 = y4 + z4 | 0;
            }
            H[x + 320 >> 2] = y0;
            H[x + 324 >> 2] = y1;
            H[x + 328 >> 2] = y2;
            H[x + 332 >> 2] = y3;
            H[x + 336 >> 2] = y4;
        }
        return { hash: hash };
    };
    // If we'e running in Node.JS, export a module.
    if (typeof module !== 'undefined') {
        module.exports = Rusha;
    } else if (typeof window !== 'undefined') {
        window.Rusha = Rusha;
    }
    // If we're running in a webworker, accept
    // messages containing a jobid and a buffer
    // or blob object, and return the hash result.
    if (typeof FileReaderSync !== 'undefined') {
        var reader = new FileReaderSync(), hasher = new Rusha(4 * 1024 * 1024);
        self.onmessage = function onMessage(event) {
            var hash, data = event.data.data;
            try {
                hash = hasher.digest(data);
                self.postMessage({
                    id: event.data.id,
                    hash: hash
                });
            } catch (e) {
                self.postMessage({
                    id: event.data.id,
                    error: e.name
                });
            }
        };
    }
}());
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],149:[function(require,module,exports){
var tick = 1
var maxTick = 65535
var resolution = 4
var inc = function () {
  tick = (tick + 1) & maxTick
}

var timer = setInterval(inc, (1000 / resolution) | 0)
if (timer.unref) timer.unref()

module.exports = function (seconds) {
  var size = resolution * (seconds || 5)
  var buffer = [0]
  var pointer = 1
  var last = (tick - 1) & maxTick

  return function (delta) {
    var dist = (tick - last) & maxTick
    if (dist > size) dist = size
    last = tick

    while (dist--) {
      if (pointer === size) pointer = 0
      buffer[pointer] = buffer[pointer === 0 ? size - 1 : pointer - 1]
      pointer++
    }

    if (delta) buffer[pointer - 1] += delta

    var top = buffer[pointer - 1]
    var btm = buffer.length < size ? 0 : buffer[pointer === size ? 0 : pointer]

    return buffer.length < resolution ? top : (top - btm) * resolution / buffer.length
  }
}

},{}],150:[function(require,module,exports){
/* global Blob, URL */

var once = require('once')

module.exports = function getBlobURL (stream, mimeType, cb) {
  cb = once(cb)
  var chunks = []
  stream
    .on('data', function (chunk) {
      chunks.push(chunk)
    })
    .on('end', function () {
      var blob = mimeType ? new Blob(chunks, { type: mimeType }) : new Blob(chunks)
      var url = URL.createObjectURL(blob)
      cb(null, url)
    })
    .on('error', cb)
}

},{"once":152}],151:[function(require,module,exports){
arguments[4][20][0].apply(exports,arguments)
},{"dup":20}],152:[function(require,module,exports){
arguments[4][21][0].apply(exports,arguments)
},{"dup":21,"wrappy":151}],153:[function(require,module,exports){
(function (Buffer){
var once = require('once')

module.exports = function getBuffer (stream, length, cb) {
  cb = once(cb)
  var buf = new Buffer(length)
  var offset = 0
  stream
    .on('data', function (chunk) {
      chunk.copy(buf, offset)
      offset += chunk.length
    })
    .on('end', function () { cb(null, buf) })
    .on('error', cb)
}

}).call(this,require("buffer").Buffer)
},{"buffer":25,"once":155}],154:[function(require,module,exports){
arguments[4][20][0].apply(exports,arguments)
},{"dup":20}],155:[function(require,module,exports){
arguments[4][21][0].apply(exports,arguments)
},{"dup":21,"wrappy":154}],156:[function(require,module,exports){
(function (process){
module.exports = Discovery

var debug = require('debug')('torrent-discovery')
var DHT = require('bittorrent-dht/client') // empty object in browser
var EventEmitter = require('events').EventEmitter
var extend = require('xtend')
var inherits = require('inherits')
var parallel = require('run-parallel')
var Tracker = require('bittorrent-tracker/client')

inherits(Discovery, EventEmitter)

function Discovery (opts) {
  var self = this
  if (!(self instanceof Discovery)) return new Discovery(opts)
  EventEmitter.call(self)

  if (!opts.peerId) throw new Error('Option `peerId` is required')
  if (!opts.infoHash) throw new Error('Option `infoHash` is required')
  if (!process.browser && !opts.port) throw new Error('Option `port` is required')

  self.peerId = typeof opts.peerId === 'string'
    ? opts.peerId
    : opts.peerId.toString('hex')
  self.infoHash = typeof opts.infoHash === 'string'
    ? opts.infoHash
    : opts.infoHash.toString('hex')
  self._port = opts.port // torrent port

  self.destroyed = false

  self._announce = opts.announce || []
  self._intervalMs = opts.intervalMs || (15 * 60 * 1000)
  self._trackerOpts = null
  self._dhtAnnouncing = false
  self._dhtTimeout = false
  self._internalDHT = false // is the DHT created internally?

  self._onWarning = function (err) {
    self.emit('warning', err)
  }
  self._onError = function (err) {
    self.emit('error', err)
  }
  self._onDHTPeer = function (peer, infoHash) {
    if (infoHash.toString('hex') !== self.infoHash) return
    self.emit('peer', peer.host + ':' + peer.port)
  }
  self._onTrackerPeer = function (peer) {
    self.emit('peer', peer)
  }
  self._onTrackerAnnounce = function () {
    self.emit('trackerAnnounce')
  }

  if (opts.tracker === false) {
    self.tracker = null
  } else if (opts.tracker && typeof opts.tracker === 'object') {
    self._trackerOpts = extend(opts.tracker)
    self.tracker = self._createTracker()
  } else {
    self.tracker = self._createTracker()
  }

  if (opts.dht === false || typeof DHT !== 'function') {
    self.dht = null
  } else if (opts.dht && typeof opts.dht.addNode === 'function') {
    self.dht = opts.dht
  } else if (opts.dht && typeof opts.dht === 'object') {
    self.dht = createDHT(opts.dhtPort, opts.dht)
  } else {
    self.dht = createDHT(opts.dhtPort)
  }

  if (self.dht) {
    self.dht.on('peer', self._onDHTPeer)
    self._dhtAnnounce()
  }

  function createDHT (port, opts) {
    var dht = new DHT(opts)
    dht.on('warning', self._onWarning)
    dht.on('error', self._onError)
    dht.listen(port)
    self._internalDHT = true
    return dht
  }
}

Discovery.prototype.updatePort = function (port) {
  var self = this
  if (port === self._port) return
  self._port = port

  if (self.dht) self._dhtAnnounce()

  if (self.tracker) {
    self.tracker.stop()
    self.tracker.destroy(function () {
      self.tracker = self._createTracker()
    })
  }
}

Discovery.prototype.destroy = function (cb) {
  var self = this
  if (self.destroyed) return
  self.destroyed = true

  clearTimeout(self._dhtTimeout)

  var tasks = []

  if (self.tracker) {
    self.tracker.stop()
    self.tracker.removeListener('warning', self._onWarning)
    self.tracker.removeListener('error', self._onError)
    self.tracker.removeListener('peer', self._onTrackerPeer)
    self.tracker.removeListener('update', self._onTrackerAnnounce)
    tasks.push(function (cb) {
      self.tracker.destroy(cb)
    })
  }

  if (self.dht) {
    self.dht.removeListener('peer', self._onDHTPeer)
  }

  if (self._internalDHT) {
    self.dht.removeListener('warning', self._onWarning)
    self.dht.removeListener('error', self._onError)
    tasks.push(function (cb) {
      self.dht.destroy(cb)
    })
  }

  parallel(tasks, cb)

  // cleanup
  self.dht = null
  self.tracker = null
  self._announce = null
}

Discovery.prototype._createTracker = function () {
  var self = this

  var opts = extend(self._trackerOpts, {
    infoHash: self.infoHash,
    announce: self._announce,
    peerId: self.peerId,
    port: self._port
  })

  var tracker = new Tracker(opts)
  tracker.on('warning', self._onWarning)
  tracker.on('error', self._onError)
  tracker.on('peer', self._onTrackerPeer)
  tracker.on('update', self._onTrackerAnnounce)
  tracker.setInterval(self._intervalMs)
  tracker.start()
  return tracker
}

Discovery.prototype._dhtAnnounce = function () {
  var self = this
  if (self._dhtAnnouncing) return
  debug('dht announce')

  self._dhtAnnouncing = true
  clearTimeout(self._dhtTimeout)

  self.dht.announce(self.infoHash, self._port, function (err) {
    self._dhtAnnouncing = false
    debug('dht announce complete')

    if (err) self.emit('warning', err)
    self.emit('dhtAnnounce')

    if (!self.destroyed) {
      self._dhtTimeout = setTimeout(function () {
        self._dhtAnnounce()
      }, getRandomTimeout())
      if (self._dhtTimeout.unref) self._dhtTimeout.unref()
    }
  })

  // Returns timeout interval, with some random jitter
  function getRandomTimeout () {
    return self._intervalMs + Math.floor(Math.random() * self._intervalMs / 5)
  }
}

}).call(this,require('_process'))
},{"_process":33,"bittorrent-dht/client":24,"bittorrent-tracker/client":16,"debug":93,"events":29,"inherits":101,"run-parallel":139,"xtend":172}],157:[function(require,module,exports){
(function (Buffer){
module.exports = Piece

var BLOCK_LENGTH = 1 << 14

function Piece (length) {
  if (!(this instanceof Piece)) return new Piece(length)

  this.length = length
  this.missing = length
  this.sources = null

  this._chunks = Math.ceil(length / BLOCK_LENGTH)
  this._remainder = (length % BLOCK_LENGTH) || BLOCK_LENGTH
  this._buffered = 0
  this._buffer = null
  this._cancellations = null
  this._reservations = 0
  this._flushed = false
}

Piece.BLOCK_LENGTH = BLOCK_LENGTH

Piece.prototype.chunkLength = function (i) {
  return i === this._chunks - 1 ? this._remainder : BLOCK_LENGTH
}

Piece.prototype.chunkOffset = function (i) {
  return i * BLOCK_LENGTH
}

Piece.prototype.reserve = function () {
  if (!this.init()) return -1
  if (this._cancellations.length) return this._cancellations.pop()
  if (this._reservations < this._chunks) return this._reservations++
  return -1
}

Piece.prototype.cancel = function (i) {
  if (!this.init()) return
  this._cancellations.push(i)
}

Piece.prototype.get = function (i) {
  if (!this.init()) return null
  return this._buffer[i]
}

Piece.prototype.set = function (i, data, source) {
  if (!this.init()) return false
  if (!this._buffer[i]) {
    this._buffered++
    this._buffer[i] = data
    this.missing -= data.length
    if (this.sources.indexOf(source) === -1) {
      this.sources.push(source)
    }
  }
  return this._buffered === this._chunks
}

Piece.prototype.flush = function () {
  if (!this._buffer || this._chunks !== this._buffered) return null
  var buffer = Buffer.concat(this._buffer, this.length)
  this._buffer = null
  this._cancellations = null
  this.sources = null
  this._flushed = true
  return buffer
}

Piece.prototype.init = function () {
  if (this._flushed) return false
  if (this._buffer) return true
  this._buffer = new Array(this._chunks)
  this._cancellations = []
  this.sources = []
  return true
}

}).call(this,require("buffer").Buffer)
},{"buffer":25}],158:[function(require,module,exports){
"use strict"

function unique_pred(list, compare) {
  var ptr = 1
    , len = list.length
    , a=list[0], b=list[0]
  for(var i=1; i<len; ++i) {
    b = a
    a = list[i]
    if(compare(a, b)) {
      if(i === ptr) {
        ptr++
        continue
      }
      list[ptr++] = a
    }
  }
  list.length = ptr
  return list
}

function unique_eq(list) {
  var ptr = 1
    , len = list.length
    , a=list[0], b = list[0]
  for(var i=1; i<len; ++i, b=a) {
    b = a
    a = list[i]
    if(a !== b) {
      if(i === ptr) {
        ptr++
        continue
      }
      list[ptr++] = a
    }
  }
  list.length = ptr
  return list
}

function unique(list, compare, sorted) {
  if(list.length === 0) {
    return list
  }
  if(compare) {
    if(!sorted) {
      list.sort(compare)
    }
    return unique_pred(list, compare)
  }
  if(!sorted) {
    list.sort()
  }
  return unique_eq(list)
}

module.exports = unique

},{}],159:[function(require,module,exports){
module.exports = remove

function remove (arr, i) {
  if (i >= arr.length || i < 0) return
  var last = arr.pop()
  if (i < arr.length) {
    var tmp = arr[i]
    arr[i] = last
    return tmp
  }
  return last
}

},{}],160:[function(require,module,exports){
(function (Buffer){
var bencode = require('bencode')
var BitField = require('bitfield')
var debug = require('debug')('ut_metadata')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var sha1 = require('simple-sha1')

var MAX_METADATA_SIZE = 10000000 // 10MB
var BITFIELD_GROW = 1000
var PIECE_LENGTH = 16 * 1024

module.exports = function (metadata) {
  inherits(ut_metadata, EventEmitter)

  function ut_metadata (wire) {
    EventEmitter.call(this)

    this._wire = wire

    this._metadataComplete = false
    this._metadataSize = null
    this._remainingRejects = null // how many reject messages to tolerate before quitting
    this._fetching = false

    // The largest .torrent file that I know of is ~1-2MB, which is ~100 pieces.
    // Therefore, cap the bitfield to 10x that (1000 pieces) so a malicious peer can't
    // make it grow to fill all memory.
    this._bitfield = new BitField(0, { grow: BITFIELD_GROW })

    if (Buffer.isBuffer(metadata)) {
      this.setMetadata(metadata)
    }
  }

  // Name of the bittorrent-protocol extension
  ut_metadata.prototype.name = 'ut_metadata'

  ut_metadata.prototype.onHandshake = function (infoHash, peerId, extensions) {
    this._infoHash = infoHash
  }

  ut_metadata.prototype.onExtendedHandshake = function (handshake) {
    if (!handshake.m || !handshake.m.ut_metadata) {
      return this.emit('warning', new Error('Peer does not support ut_metadata'))
    }
    if (!handshake.metadata_size) {
      return this.emit('warning', new Error('Peer does not have metadata'))
    }

    if (handshake.metadata_size > MAX_METADATA_SIZE) {
      return this.emit('warning', new Error('Peer gave maliciously large metadata size'))
    }

    this._metadataSize = handshake.metadata_size
    this._numPieces = Math.ceil(this._metadataSize / PIECE_LENGTH)
    this._remainingRejects = this._numPieces * 2

    if (this._fetching) {
      this._requestPieces()
    }
  }

  ut_metadata.prototype.onMessage = function (buf) {
    var dict, trailer
    try {
      var str = buf.toString()
      var trailerIndex = str.indexOf('ee') + 2
      dict = bencode.decode(str.substring(0, trailerIndex))
      trailer = buf.slice(trailerIndex)
    } catch (err) {
      // drop invalid messages
      return
    }

    switch (dict.msg_type) {
      case 0:
        // ut_metadata request (from peer)
        // example: { 'msg_type': 0, 'piece': 0 }
        this._onRequest(dict.piece)
        break
      case 1:
        // ut_metadata data (in response to our request)
        // example: { 'msg_type': 1, 'piece': 0, 'total_size': 3425 }
        this._onData(dict.piece, trailer, dict.total_size)
        break
      case 2:
        // ut_metadata reject (peer doesn't have piece we requested)
        // { 'msg_type': 2, 'piece': 0 }
        this._onReject(dict.piece)
        break
    }
  }

  /**
   * Ask the peer to send metadata.
   * @public
   */
  ut_metadata.prototype.fetch = function () {
    if (this._metadataComplete) {
      return
    }
    this._fetching = true
    if (this._metadataSize) {
      this._requestPieces()
    }
  }

  /**
   * Stop asking the peer to send metadata.
   * @public
   */
  ut_metadata.prototype.cancel = function () {
    this._fetching = false
  }

  ut_metadata.prototype.setMetadata = function (metadata) {
    if (this._metadataComplete) return true
    debug('set metadata')

    // if full torrent dictionary was passed in, pull out just `info` key
    try {
      var info = bencode.decode(metadata).info
      if (info) {
        metadata = bencode.encode(info)
      }
    } catch (err) {}

    // check hash
    if (this._infoHash && this._infoHash !== sha1.sync(metadata)) {
      return false
    }

    this.cancel()

    this.metadata = metadata
    this._metadataComplete = true
    this._metadataSize = this.metadata.length
    this._wire.extendedHandshake.metadata_size = this._metadataSize

    this.emit('metadata', bencode.encode({ info: bencode.decode(this.metadata) }))

    return true
  }

  ut_metadata.prototype._send = function (dict, trailer) {
    var buf = bencode.encode(dict)
    if (Buffer.isBuffer(trailer)) {
      buf = Buffer.concat([buf, trailer])
    }
    this._wire.extended('ut_metadata', buf)
  }

  ut_metadata.prototype._request = function (piece) {
    this._send({ msg_type: 0, piece: piece })
  }

  ut_metadata.prototype._data = function (piece, buf, totalSize) {
    var msg = { msg_type: 1, piece: piece }
    if (typeof totalSize === 'number') {
      msg.total_size = totalSize
    }
    this._send(msg, buf)
  }

  ut_metadata.prototype._reject = function (piece) {
    this._send({ msg_type: 2, piece: piece })
  }

  ut_metadata.prototype._onRequest = function (piece) {
    if (!this._metadataComplete) {
      this._reject(piece)
      return
    }
    var start = piece * PIECE_LENGTH
    var end = start + PIECE_LENGTH
    if (end > this._metadataSize) {
      end = this._metadataSize
    }
    var buf = this.metadata.slice(start, end)
    this._data(piece, buf, this._metadataSize)
  }

  ut_metadata.prototype._onData = function (piece, buf, totalSize) {
    if (buf.length > PIECE_LENGTH) {
      return
    }
    buf.copy(this.metadata, piece * PIECE_LENGTH)
    this._bitfield.set(piece)
    this._checkDone()
  }

  ut_metadata.prototype._onReject = function (piece) {
    if (this._remainingRejects > 0 && this._fetching) {
      // If we haven't been rejected too much, then try to request the piece again
      this._request(piece)
      this._remainingRejects -= 1
    } else {
      this.emit('warning', new Error('Peer sent "reject" too much'))
    }
  }

  ut_metadata.prototype._requestPieces = function () {
    this.metadata = new Buffer(this._metadataSize)

    for (var piece = 0; piece < this._numPieces; piece++) {
      this._request(piece)
    }
  }

  ut_metadata.prototype._checkDone = function () {
    var done = true
    for (var piece = 0; piece < this._numPieces; piece++) {
      if (!this._bitfield.get(piece)) {
        done = false
        break
      }
    }
    if (!done) return

    // attempt to set metadata -- may fail sha1 check
    var success = this.setMetadata(this.metadata)

    if (!success) {
      this._failedMetadata()
    }
  }

  ut_metadata.prototype._failedMetadata = function () {
    // reset bitfield & try again
    this._bitfield = new BitField(0, { grow: BITFIELD_GROW })
    this._remainingRejects -= this._numPieces
    if (this._remainingRejects > 0) {
      this._requestPieces()
    } else {
      this.emit('warning', new Error('Peer sent invalid metadata'))
    }
  }

  return ut_metadata
}

}).call(this,require("buffer").Buffer)
},{"bencode":161,"bitfield":10,"buffer":25,"debug":93,"events":29,"inherits":101,"simple-sha1":147}],161:[function(require,module,exports){
arguments[4][62][0].apply(exports,arguments)
},{"./lib/decode":162,"./lib/encode":164,"dup":62}],162:[function(require,module,exports){
arguments[4][63][0].apply(exports,arguments)
},{"./dict":163,"buffer":25,"dup":63}],163:[function(require,module,exports){
arguments[4][14][0].apply(exports,arguments)
},{"dup":14}],164:[function(require,module,exports){
arguments[4][65][0].apply(exports,arguments)
},{"buffer":25,"dup":65}],165:[function(require,module,exports){
/**
  DataStream reads scalars, arrays and structs of data from an ArrayBuffer.
  It's like a file-like DataView on steroids.

  @param {ArrayBuffer} arrayBuffer ArrayBuffer to read from.
  @param {?Number} byteOffset Offset from arrayBuffer beginning for the DataStream.
  @param {?Boolean} endianness DataStream.BIG_ENDIAN or DataStream.LITTLE_ENDIAN (the default).
  */
var DataStream = function(arrayBuffer, byteOffset, endianness) {
  this._byteOffset = byteOffset || 0;
  if (arrayBuffer instanceof ArrayBuffer) {
    this.buffer = arrayBuffer;
  } else if (typeof arrayBuffer == "object") {
    this.dataView = arrayBuffer;
    if (byteOffset) {
      this._byteOffset += byteOffset;
    }
  } else {
    this.buffer = new ArrayBuffer(arrayBuffer || 0);
  }
  this.position = 0;
  this.endianness = endianness == null ? DataStream.LITTLE_ENDIAN : endianness;
};
module.exports = DataStream;
DataStream.prototype = {};


/**
  Saves the DataStream contents to the given filename.
  Uses Chrome's anchor download property to initiate download.
 
  @param {string} filename Filename to save as.
  @return {null}
  */
DataStream.prototype.save = function(filename) {
  var blob = new Blob([this.buffer]);
  var URL = (window.webkitURL || window.URL);
  if (URL && URL.createObjectURL) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.setAttribute('href', url);
      a.setAttribute('download', filename);
      a.click();
      URL.revokeObjectURL(url);
  } else {
      throw("DataStream.save: Can't create object URL.");
  }
};

/**
  Big-endian const to use as default endianness.
  @type {boolean}
  */
DataStream.BIG_ENDIAN = false;

/**
  Little-endian const to use as default endianness.
  @type {boolean}
  */
DataStream.LITTLE_ENDIAN = true;

/**
  Whether to extend DataStream buffer when trying to write beyond its size.
  If set, the buffer is reallocated to twice its current size until the
  requested write fits the buffer.
  @type {boolean}
  */
DataStream.prototype._dynamicSize = true;
Object.defineProperty(DataStream.prototype, 'dynamicSize',
  { get: function() {
      return this._dynamicSize;
    },
    set: function(v) {
      if (!v) {
        this._trimAlloc();
      }
      this._dynamicSize = v;
    } });

/**
  Virtual byte length of the DataStream backing buffer.
  Updated to be max of original buffer size and last written size.
  If dynamicSize is false is set to buffer size.
  @type {number}
  */
DataStream.prototype._byteLength = 0;

/**
  Returns the byte length of the DataStream object.
  @type {number}
  */
Object.defineProperty(DataStream.prototype, 'byteLength',
  { get: function() {
    return this._byteLength - this._byteOffset;
  }});

/**
  Set/get the backing ArrayBuffer of the DataStream object.
  The setter updates the DataView to point to the new buffer.
  @type {Object}
  */
Object.defineProperty(DataStream.prototype, 'buffer',
  { get: function() {
      this._trimAlloc();
      return this._buffer;
    },
    set: function(v) {
      this._buffer = v;
      this._dataView = new DataView(this._buffer, this._byteOffset);
      this._byteLength = this._buffer.byteLength;
    } });

/**
  Set/get the byteOffset of the DataStream object.
  The setter updates the DataView to point to the new byteOffset.
  @type {number}
  */
Object.defineProperty(DataStream.prototype, 'byteOffset',
  { get: function() {
      return this._byteOffset;
    },
    set: function(v) {
      this._byteOffset = v;
      this._dataView = new DataView(this._buffer, this._byteOffset);
      this._byteLength = this._buffer.byteLength;
    } });

/**
  Set/get the backing DataView of the DataStream object.
  The setter updates the buffer and byteOffset to point to the DataView values.
  @type {Object}
  */
Object.defineProperty(DataStream.prototype, 'dataView',
  { get: function() {
      return this._dataView;
    },
    set: function(v) {
      this._byteOffset = v.byteOffset;
      this._buffer = v.buffer;
      this._dataView = new DataView(this._buffer, this._byteOffset);
      this._byteLength = this._byteOffset + v.byteLength;
    } });

/**
  Internal function to resize the DataStream buffer when required.
  @param {number} extra Number of bytes to add to the buffer allocation.
  @return {null}
  */
DataStream.prototype._realloc = function(extra) {
  if (!this._dynamicSize) {
    return;
  }
  var req = this._byteOffset + this.position + extra;
  var blen = this._buffer.byteLength;
  if (req <= blen) {
    if (req > this._byteLength) {
      this._byteLength = req;
    }
    return;
  }
  if (blen < 1) {
    blen = 1;
  }
  while (req > blen) {
    blen *= 2;
  }
  var buf = new ArrayBuffer(blen);
  var src = new Uint8Array(this._buffer);
  var dst = new Uint8Array(buf, 0, src.length);
  dst.set(src);
  this.buffer = buf;
  this._byteLength = req;
};

/**
  Internal function to trim the DataStream buffer when required.
  Used for stripping out the extra bytes from the backing buffer when
  the virtual byteLength is smaller than the buffer byteLength (happens after
  growing the buffer with writes and not filling the extra space completely).

  @return {null}
  */
DataStream.prototype._trimAlloc = function() {
  if (this._byteLength == this._buffer.byteLength) {
    return;
  }
  var buf = new ArrayBuffer(this._byteLength);
  var dst = new Uint8Array(buf);
  var src = new Uint8Array(this._buffer, 0, dst.length);
  dst.set(src);
  this.buffer = buf;
};

/**
  Internal function to trim the DataStream buffer when required.
  Used for stripping out the first bytes when not needed anymore.

  @return {null}
  */
DataStream.prototype.shift = function(offset) {
  var buf = new ArrayBuffer(this._byteLength-offset);
  var dst = new Uint8Array(buf);
  var src = new Uint8Array(this._buffer, offset, dst.length);
  dst.set(src);
  this.buffer = buf;
  this.position -= offset;
};

/**
  Sets the DataStream read/write position to given position.
  Clamps between 0 and DataStream length.

  @param {number} pos Position to seek to.
  @return {null}
  */
DataStream.prototype.seek = function(pos) {
  var npos = Math.max(0, Math.min(this.byteLength, pos));
  this.position = (isNaN(npos) || !isFinite(npos)) ? 0 : npos;
};

/**
  Returns true if the DataStream seek pointer is at the end of buffer and
  there's no more data to read.

  @return {boolean} True if the seek pointer is at the end of the buffer.
  */
DataStream.prototype.isEof = function() {
  return (this.position >= this._byteLength);
};

/**
  Maps an Int32Array into the DataStream buffer, swizzling it to native
  endianness in-place. The current offset from the start of the buffer needs to
  be a multiple of element size, just like with typed array views.

  Nice for quickly reading in data. Warning: potentially modifies the buffer
  contents.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} Int32Array to the DataStream backing buffer.
  */
DataStream.prototype.mapInt32Array = function(length, e) {
  this._realloc(length * 4);
  var arr = new Int32Array(this._buffer, this.byteOffset+this.position, length);
  DataStream.arrayToNative(arr, e == null ? this.endianness : e);
  this.position += length * 4;
  return arr;
};

/**
  Maps an Int16Array into the DataStream buffer, swizzling it to native
  endianness in-place. The current offset from the start of the buffer needs to
  be a multiple of element size, just like with typed array views.

  Nice for quickly reading in data. Warning: potentially modifies the buffer
  contents.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} Int16Array to the DataStream backing buffer.
  */
DataStream.prototype.mapInt16Array = function(length, e) {
  this._realloc(length * 2);
  var arr = new Int16Array(this._buffer, this.byteOffset+this.position, length);
  DataStream.arrayToNative(arr, e == null ? this.endianness : e);
  this.position += length * 2;
  return arr;
};

/**
  Maps an Int8Array into the DataStream buffer.

  Nice for quickly reading in data.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} Int8Array to the DataStream backing buffer.
  */
DataStream.prototype.mapInt8Array = function(length) {
  this._realloc(length * 1);
  var arr = new Int8Array(this._buffer, this.byteOffset+this.position, length);
  this.position += length * 1;
  return arr;
};

/**
  Maps a Uint32Array into the DataStream buffer, swizzling it to native
  endianness in-place. The current offset from the start of the buffer needs to
  be a multiple of element size, just like with typed array views.

  Nice for quickly reading in data. Warning: potentially modifies the buffer
  contents.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} Uint32Array to the DataStream backing buffer.
  */
DataStream.prototype.mapUint32Array = function(length, e) {
  this._realloc(length * 4);
  var arr = new Uint32Array(this._buffer, this.byteOffset+this.position, length);
  DataStream.arrayToNative(arr, e == null ? this.endianness : e);
  this.position += length * 4;
  return arr;
};

/**
  Maps a Uint16Array into the DataStream buffer, swizzling it to native
  endianness in-place. The current offset from the start of the buffer needs to
  be a multiple of element size, just like with typed array views.

  Nice for quickly reading in data. Warning: potentially modifies the buffer
  contents.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} Uint16Array to the DataStream backing buffer.
  */
DataStream.prototype.mapUint16Array = function(length, e) {
  this._realloc(length * 2);
  var arr = new Uint16Array(this._buffer, this.byteOffset+this.position, length);
  DataStream.arrayToNative(arr, e == null ? this.endianness : e);
  this.position += length * 2;
  return arr;
};

/**
  Maps a Uint8Array into the DataStream buffer.

  Nice for quickly reading in data.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} Uint8Array to the DataStream backing buffer.
  */
DataStream.prototype.mapUint8Array = function(length) {
  this._realloc(length * 1);
  var arr = new Uint8Array(this._buffer, this.byteOffset+this.position, length);
  this.position += length * 1;
  return arr;
};

/**
  Maps a Float64Array into the DataStream buffer, swizzling it to native
  endianness in-place. The current offset from the start of the buffer needs to
  be a multiple of element size, just like with typed array views.

  Nice for quickly reading in data. Warning: potentially modifies the buffer
  contents.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} Float64Array to the DataStream backing buffer.
  */
DataStream.prototype.mapFloat64Array = function(length, e) {
  this._realloc(length * 8);
  var arr = new Float64Array(this._buffer, this.byteOffset+this.position, length);
  DataStream.arrayToNative(arr, e == null ? this.endianness : e);
  this.position += length * 8;
  return arr;
};

/**
  Maps a Float32Array into the DataStream buffer, swizzling it to native
  endianness in-place. The current offset from the start of the buffer needs to
  be a multiple of element size, just like with typed array views.

  Nice for quickly reading in data. Warning: potentially modifies the buffer
  contents.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} Float32Array to the DataStream backing buffer.
  */
DataStream.prototype.mapFloat32Array = function(length, e) {
  this._realloc(length * 4);
  var arr = new Float32Array(this._buffer, this.byteOffset+this.position, length);
  DataStream.arrayToNative(arr, e == null ? this.endianness : e);
  this.position += length * 4;
  return arr;
};

/**
  Reads an Int32Array of desired length and endianness from the DataStream.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} The read Int32Array.
 */
DataStream.prototype.readInt32Array = function(length, e) {
  length = length == null ? (this.byteLength-this.position / 4) : length;
  var arr = new Int32Array(length);
  DataStream.memcpy(arr.buffer, 0,
                    this.buffer, this.byteOffset+this.position,
                    length*arr.BYTES_PER_ELEMENT);
  DataStream.arrayToNative(arr, e == null ? this.endianness : e);
  this.position += arr.byteLength;
  return arr;
};

/**
  Reads an Int16Array of desired length and endianness from the DataStream.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} The read Int16Array.
 */
DataStream.prototype.readInt16Array = function(length, e) {
  length = length == null ? (this.byteLength-this.position / 2) : length;
  var arr = new Int16Array(length);
  DataStream.memcpy(arr.buffer, 0,
                    this.buffer, this.byteOffset+this.position,
                    length*arr.BYTES_PER_ELEMENT);
  DataStream.arrayToNative(arr, e == null ? this.endianness : e);
  this.position += arr.byteLength;
  return arr;
};

/**
  Reads an Int8Array of desired length from the DataStream.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} The read Int8Array.
 */
DataStream.prototype.readInt8Array = function(length) {
  length = length == null ? (this.byteLength-this.position) : length;
  var arr = new Int8Array(length);
  DataStream.memcpy(arr.buffer, 0,
                    this.buffer, this.byteOffset+this.position,
                    length*arr.BYTES_PER_ELEMENT);
  this.position += arr.byteLength;
  return arr;
};

/**
  Reads a Uint32Array of desired length and endianness from the DataStream.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} The read Uint32Array.
 */
DataStream.prototype.readUint32Array = function(length, e) {
  length = length == null ? (this.byteLength-this.position / 4) : length;
  var arr = new Uint32Array(length);
  DataStream.memcpy(arr.buffer, 0,
                    this.buffer, this.byteOffset+this.position,
                    length*arr.BYTES_PER_ELEMENT);
  DataStream.arrayToNative(arr, e == null ? this.endianness : e);
  this.position += arr.byteLength;
  return arr;
};

/**
  Reads a Uint16Array of desired length and endianness from the DataStream.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} The read Uint16Array.
 */
DataStream.prototype.readUint16Array = function(length, e) {
  length = length == null ? (this.byteLength-this.position / 2) : length;
  var arr = new Uint16Array(length);
  DataStream.memcpy(arr.buffer, 0,
                    this.buffer, this.byteOffset+this.position,
                    length*arr.BYTES_PER_ELEMENT);
  DataStream.arrayToNative(arr, e == null ? this.endianness : e);
  this.position += arr.byteLength;
  return arr;
};

/**
  Reads a Uint8Array of desired length from the DataStream.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} The read Uint8Array.
 */
DataStream.prototype.readUint8Array = function(length) {
  length = length == null ? (this.byteLength-this.position) : length;
  var arr = new Uint8Array(length);
  DataStream.memcpy(arr.buffer, 0,
                    this.buffer, this.byteOffset+this.position,
                    length*arr.BYTES_PER_ELEMENT);
  this.position += arr.byteLength;
  return arr;
};

/**
  Reads a Float64Array of desired length and endianness from the DataStream.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} The read Float64Array.
 */
DataStream.prototype.readFloat64Array = function(length, e) {
  length = length == null ? (this.byteLength-this.position / 8) : length;
  var arr = new Float64Array(length);
  DataStream.memcpy(arr.buffer, 0,
                    this.buffer, this.byteOffset+this.position,
                    length*arr.BYTES_PER_ELEMENT);
  DataStream.arrayToNative(arr, e == null ? this.endianness : e);
  this.position += arr.byteLength;
  return arr;
};

/**
  Reads a Float32Array of desired length and endianness from the DataStream.

  @param {number} length Number of elements to map.
  @param {?boolean} e Endianness of the data to read.
  @return {Object} The read Float32Array.
 */
DataStream.prototype.readFloat32Array = function(length, e) {
  length = length == null ? (this.byteLength-this.position / 4) : length;
  var arr = new Float32Array(length);
  DataStream.memcpy(arr.buffer, 0,
                    this.buffer, this.byteOffset+this.position,
                    length*arr.BYTES_PER_ELEMENT);
  DataStream.arrayToNative(arr, e == null ? this.endianness : e);
  this.position += arr.byteLength;
  return arr;
};

/**
  Writes an Int32Array of specified endianness to the DataStream.

  @param {Object} arr The array to write.
  @param {?boolean} e Endianness of the data to write.
 */
DataStream.prototype.writeInt32Array = function(arr, e) {
  this._realloc(arr.length * 4);
  if (arr instanceof Int32Array &&
      this.byteOffset+this.position % arr.BYTES_PER_ELEMENT === 0) {
    DataStream.memcpy(this._buffer, this.byteOffset+this.position,
                      arr.buffer, 0,
                      arr.byteLength);
    this.mapInt32Array(arr.length, e);
  } else {
    for (var i=0; i<arr.length; i++) {
      this.writeInt32(arr[i], e);
    }
  }
};

/**
  Writes an Int16Array of specified endianness to the DataStream.

  @param {Object} arr The array to write.
  @param {?boolean} e Endianness of the data to write.
 */
DataStream.prototype.writeInt16Array = function(arr, e) {
  this._realloc(arr.length * 2);
  if (arr instanceof Int16Array &&
      this.byteOffset+this.position % arr.BYTES_PER_ELEMENT === 0) {
    DataStream.memcpy(this._buffer, this.byteOffset+this.position,
                      arr.buffer, 0,
                      arr.byteLength);
    this.mapInt16Array(arr.length, e);
  } else {
    for (var i=0; i<arr.length; i++) {
      this.writeInt16(arr[i], e);
    }
  }
};

/**
  Writes an Int8Array to the DataStream.

  @param {Object} arr The array to write.
 */
DataStream.prototype.writeInt8Array = function(arr) {
  this._realloc(arr.length * 1);
  if (arr instanceof Int8Array &&
      this.byteOffset+this.position % arr.BYTES_PER_ELEMENT === 0) {
    DataStream.memcpy(this._buffer, this.byteOffset+this.position,
                      arr.buffer, 0,
                      arr.byteLength);
    this.mapInt8Array(arr.length);
  } else {
    for (var i=0; i<arr.length; i++) {
      this.writeInt8(arr[i]);
    }
  }
};

/**
  Writes a Uint32Array of specified endianness to the DataStream.

  @param {Object} arr The array to write.
  @param {?boolean} e Endianness of the data to write.
 */
DataStream.prototype.writeUint32Array = function(arr, e) {
  this._realloc(arr.length * 4);
  if (arr instanceof Uint32Array &&
      this.byteOffset+this.position % arr.BYTES_PER_ELEMENT === 0) {
    DataStream.memcpy(this._buffer, this.byteOffset+this.position,
                      arr.buffer, 0,
                      arr.byteLength);
    this.mapUint32Array(arr.length, e);
  } else {
    for (var i=0; i<arr.length; i++) {
      this.writeUint32(arr[i], e);
    }
  }
};

/**
  Writes a Uint16Array of specified endianness to the DataStream.

  @param {Object} arr The array to write.
  @param {?boolean} e Endianness of the data to write.
 */
DataStream.prototype.writeUint16Array = function(arr, e) {
  this._realloc(arr.length * 2);
  if (arr instanceof Uint16Array &&
      this.byteOffset+this.position % arr.BYTES_PER_ELEMENT === 0) {
    DataStream.memcpy(this._buffer, this.byteOffset+this.position,
                      arr.buffer, 0,
                      arr.byteLength);
    this.mapUint16Array(arr.length, e);
  } else {
    for (var i=0; i<arr.length; i++) {
      this.writeUint16(arr[i], e);
    }
  }
};

/**
  Writes a Uint8Array to the DataStream.

  @param {Object} arr The array to write.
 */
DataStream.prototype.writeUint8Array = function(arr) {
  this._realloc(arr.length * 1);
  if (arr instanceof Uint8Array &&
      this.byteOffset+this.position % arr.BYTES_PER_ELEMENT === 0) {
    DataStream.memcpy(this._buffer, this.byteOffset+this.position,
                      arr.buffer, 0,
                      arr.byteLength);
    this.mapUint8Array(arr.length);
  } else {
    for (var i=0; i<arr.length; i++) {
      this.writeUint8(arr[i]);
    }
  }
};

/**
  Writes a Float64Array of specified endianness to the DataStream.

  @param {Object} arr The array to write.
  @param {?boolean} e Endianness of the data to write.
 */
DataStream.prototype.writeFloat64Array = function(arr, e) {
  this._realloc(arr.length * 8);
  if (arr instanceof Float64Array &&
      this.byteOffset+this.position % arr.BYTES_PER_ELEMENT === 0) {
    DataStream.memcpy(this._buffer, this.byteOffset+this.position,
                      arr.buffer, 0,
                      arr.byteLength);
    this.mapFloat64Array(arr.length, e);
  } else {
    for (var i=0; i<arr.length; i++) {
      this.writeFloat64(arr[i], e);
    }
  }
};

/**
  Writes a Float32Array of specified endianness to the DataStream.

  @param {Object} arr The array to write.
  @param {?boolean} e Endianness of the data to write.
 */
DataStream.prototype.writeFloat32Array = function(arr, e) {
  this._realloc(arr.length * 4);
  if (arr instanceof Float32Array &&
      this.byteOffset+this.position % arr.BYTES_PER_ELEMENT === 0) {
    DataStream.memcpy(this._buffer, this.byteOffset+this.position,
                      arr.buffer, 0,
                      arr.byteLength);
    this.mapFloat32Array(arr.length, e);
  } else {
    for (var i=0; i<arr.length; i++) {
      this.writeFloat32(arr[i], e);
    }
  }
};


/**
  Reads a 32-bit int from the DataStream with the desired endianness.

  @param {?boolean} e Endianness of the number.
  @return {number} The read number.
 */
DataStream.prototype.readInt32 = function(e) {
  var v = this._dataView.getInt32(this.position, e == null ? this.endianness : e);
  this.position += 4;
  return v;
};

/**
  Reads a 16-bit int from the DataStream with the desired endianness.

  @param {?boolean} e Endianness of the number.
  @return {number} The read number.
 */
DataStream.prototype.readInt16 = function(e) {
  var v = this._dataView.getInt16(this.position, e == null ? this.endianness : e);
  this.position += 2;
  return v;
};

/**
  Reads an 8-bit int from the DataStream.

  @return {number} The read number.
 */
DataStream.prototype.readInt8 = function() {
  var v = this._dataView.getInt8(this.position);
  this.position += 1;
  return v;
};

/**
  Reads a 32-bit unsigned int from the DataStream with the desired endianness.

  @param {?boolean} e Endianness of the number.
  @return {number} The read number.
 */
DataStream.prototype.readUint32 = function(e) {
  var v = this._dataView.getUint32(this.position, e == null ? this.endianness : e);
  this.position += 4;
  return v;
};

/**
  Reads a 16-bit unsigned int from the DataStream with the desired endianness.

  @param {?boolean} e Endianness of the number.
  @return {number} The read number.
 */
DataStream.prototype.readUint16 = function(e) {
  var v = this._dataView.getUint16(this.position, e == null ? this.endianness : e);
  this.position += 2;
  return v;
};

/**
  Reads an 8-bit unsigned int from the DataStream.

  @return {number} The read number.
 */
DataStream.prototype.readUint8 = function() {
  var v = this._dataView.getUint8(this.position);
  this.position += 1;
  return v;
};

/**
  Reads a 32-bit float from the DataStream with the desired endianness.

  @param {?boolean} e Endianness of the number.
  @return {number} The read number.
 */
DataStream.prototype.readFloat32 = function(e) {
  var v = this._dataView.getFloat32(this.position, e == null ? this.endianness : e);
  this.position += 4;
  return v;
};

/**
  Reads a 64-bit float from the DataStream with the desired endianness.

  @param {?boolean} e Endianness of the number.
  @return {number} The read number.
 */
DataStream.prototype.readFloat64 = function(e) {
  var v = this._dataView.getFloat64(this.position, e == null ? this.endianness : e);
  this.position += 8;
  return v;
};


/**
  Writes a 32-bit int to the DataStream with the desired endianness.

  @param {number} v Number to write.
  @param {?boolean} e Endianness of the number.
 */
DataStream.prototype.writeInt32 = function(v, e) {
  this._realloc(4);
  this._dataView.setInt32(this.position, v, e == null ? this.endianness : e);
  this.position += 4;
};

/**
  Writes a 16-bit int to the DataStream with the desired endianness.

  @param {number} v Number to write.
  @param {?boolean} e Endianness of the number.
 */
DataStream.prototype.writeInt16 = function(v, e) {
  this._realloc(2);
  this._dataView.setInt16(this.position, v, e == null ? this.endianness : e);
  this.position += 2;
};

/**
  Writes an 8-bit int to the DataStream.

  @param {number} v Number to write.
 */
DataStream.prototype.writeInt8 = function(v) {
  this._realloc(1);
  this._dataView.setInt8(this.position, v);
  this.position += 1;
};

/**
  Writes a 32-bit unsigned int to the DataStream with the desired endianness.

  @param {number} v Number to write.
  @param {?boolean} e Endianness of the number.
 */
DataStream.prototype.writeUint32 = function(v, e) {
  this._realloc(4);
  this._dataView.setUint32(this.position, v, e == null ? this.endianness : e);
  this.position += 4;
};

/**
  Writes a 16-bit unsigned int to the DataStream with the desired endianness.

  @param {number} v Number to write.
  @param {?boolean} e Endianness of the number.
 */
DataStream.prototype.writeUint16 = function(v, e) {
  this._realloc(2);
  this._dataView.setUint16(this.position, v, e == null ? this.endianness : e);
  this.position += 2;
};

/**
  Writes an 8-bit unsigned  int to the DataStream.

  @param {number} v Number to write.
 */
DataStream.prototype.writeUint8 = function(v) {
  this._realloc(1);
  this._dataView.setUint8(this.position, v);
  this.position += 1;
};

/**
  Writes a 32-bit float to the DataStream with the desired endianness.

  @param {number} v Number to write.
  @param {?boolean} e Endianness of the number.
 */
DataStream.prototype.writeFloat32 = function(v, e) {
  this._realloc(4);
  this._dataView.setFloat32(this.position, v, e == null ? this.endianness : e);
  this.position += 4;
};

/**
  Writes a 64-bit float to the DataStream with the desired endianness.

  @param {number} v Number to write.
  @param {?boolean} e Endianness of the number.
 */
DataStream.prototype.writeFloat64 = function(v, e) {
  this._realloc(8);
  this._dataView.setFloat64(this.position, v, e == null ? this.endianness : e);
  this.position += 8;
};

/**
  Native endianness. Either DataStream.BIG_ENDIAN or DataStream.LITTLE_ENDIAN
  depending on the platform endianness.

  @type {boolean}
 */
DataStream.endianness = new Int8Array(new Int16Array([1]).buffer)[0] > 0;

/**
  Copies byteLength bytes from the src buffer at srcOffset to the
  dst buffer at dstOffset.

  @param {Object} dst Destination ArrayBuffer to write to.
  @param {number} dstOffset Offset to the destination ArrayBuffer.
  @param {Object} src Source ArrayBuffer to read from.
  @param {number} srcOffset Offset to the source ArrayBuffer.
  @param {number} byteLength Number of bytes to copy.
 */
DataStream.memcpy = function(dst, dstOffset, src, srcOffset, byteLength) {
  var dstU8 = new Uint8Array(dst, dstOffset, byteLength);
  var srcU8 = new Uint8Array(src, srcOffset, byteLength);
  dstU8.set(srcU8);
};

/**
  Converts array to native endianness in-place.

  @param {Object} array Typed array to convert.
  @param {boolean} arrayIsLittleEndian True if the data in the array is
                                       little-endian. Set false for big-endian.
  @return {Object} The converted typed array.
 */
DataStream.arrayToNative = function(array, arrayIsLittleEndian) {
  if (arrayIsLittleEndian == this.endianness) {
    return array;
  } else {
    return this.flipArrayEndianness(array);
  }
};

/**
  Converts native endianness array to desired endianness in-place.

  @param {Object} array Typed array to convert.
  @param {boolean} littleEndian True if the converted array should be
                                little-endian. Set false for big-endian.
  @return {Object} The converted typed array.
 */
DataStream.nativeToEndian = function(array, littleEndian) {
  if (this.endianness == littleEndian) {
    return array;
  } else {
    return this.flipArrayEndianness(array);
  }
};

/**
  Flips typed array endianness in-place.

  @param {Object} array Typed array to flip.
  @return {Object} The converted typed array.
 */
DataStream.flipArrayEndianness = function(array) {
  var u8 = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (var i=0; i<array.byteLength; i+=array.BYTES_PER_ELEMENT) {
    for (var j=i+array.BYTES_PER_ELEMENT-1, k=i; j>k; j--, k++) {
      var tmp = u8[k];
      u8[k] = u8[j];
      u8[j] = tmp;
    }
  }
  return array;
};

/**
  Seek position where DataStream#readStruct ran into a problem.
  Useful for debugging struct parsing.

  @type {number}
 */
DataStream.prototype.failurePosition = 0;

/**
  Reads a struct of data from the DataStream. The struct is defined as
  a flat array of [name, type]-pairs. See the example below:

  ds.readStruct([
    'headerTag', 'uint32', // Uint32 in DataStream endianness.
    'headerTag2', 'uint32be', // Big-endian Uint32.
    'headerTag3', 'uint32le', // Little-endian Uint32.
    'array', ['[]', 'uint32', 16], // Uint32Array of length 16.
    'array2Length', 'uint32',
    'array2', ['[]', 'uint32', 'array2Length'] // Uint32Array of length array2Length
  ]);

  The possible values for the type are as follows:

  // Number types

  // Unsuffixed number types use DataStream endianness.
  // To explicitly specify endianness, suffix the type with
  // 'le' for little-endian or 'be' for big-endian,
  // e.g. 'int32be' for big-endian int32.

  'uint8' -- 8-bit unsigned int
  'uint16' -- 16-bit unsigned int
  'uint32' -- 32-bit unsigned int
  'int8' -- 8-bit int
  'int16' -- 16-bit int
  'int32' -- 32-bit int
  'float32' -- 32-bit float
  'float64' -- 64-bit float

  // String types
  'cstring' -- ASCII string terminated by a zero byte.
  'string:N' -- ASCII string of length N.
  'string,CHARSET:N' -- String of byteLength N encoded with given CHARSET.
  'u16string:N' -- UCS-2 string of length N in DataStream endianness.
  'u16stringle:N' -- UCS-2 string of length N in little-endian.
  'u16stringbe:N' -- UCS-2 string of length N in big-endian.

  // Complex types
  [name, type, name_2, type_2, ..., name_N, type_N] -- Struct
  function(dataStream, struct) {} -- Callback function to read and return data.
  {get: function(dataStream, struct) {},
   set: function(dataStream, struct) {}}
  -- Getter/setter functions to read and return data, handy for using the same
     struct definition for reading and writing structs.
  ['[]', type, length] -- Array of given type and length. The length can be either
                        a number, a string that references a previously-read
                        field, or a callback function(struct, dataStream, type){}.
                        If length is '*', reads in as many elements as it can.

  @param {Object} structDefinition Struct definition object.
  @return {Object} The read struct. Null if failed to read struct.
 */
DataStream.prototype.readStruct = function(structDefinition) {
  var struct = {}, t, v, n;
  var p = this.position;
  for (var i=0; i<structDefinition.length; i+=2) {
    t = structDefinition[i+1];
    v = this.readType(t, struct);
    if (v == null) {
      if (this.failurePosition === 0) {
        this.failurePosition = this.position;
      }
      this.position = p;
      return null;
    }
    struct[structDefinition[i]] = v;
  }
  return struct;
};

/**
  Read UCS-2 string of desired length and endianness from the DataStream.

  @param {number} length The length of the string to read.
  @param {boolean} endianness The endianness of the string data in the DataStream.
  @return {string} The read string.
 */
DataStream.prototype.readUCS2String = function(length, endianness) {
  return String.fromCharCode.apply(null, this.readUint16Array(length, endianness));
};

/**
  Write a UCS-2 string of desired endianness to the DataStream. The
  lengthOverride argument lets you define the number of characters to write.
  If the string is shorter than lengthOverride, the extra space is padded with
  zeroes.

  @param {string} str The string to write.
  @param {?boolean} endianness The endianness to use for the written string data.
  @param {?number} lengthOverride The number of characters to write.
 */
DataStream.prototype.writeUCS2String = function(str, endianness, lengthOverride) {
  if (lengthOverride == null) {
    lengthOverride = str.length;
  }
  for (var i = 0; i < str.length && i < lengthOverride; i++) {
    this.writeUint16(str.charCodeAt(i), endianness);
  }
  for (; i<lengthOverride; i++) {
    this.writeUint16(0);
  }
};

/**
  Read a string of desired length and encoding from the DataStream.

  @param {number} length The length of the string to read in bytes.
  @param {?string} encoding The encoding of the string data in the DataStream.
                            Defaults to ASCII.
  @return {string} The read string.
 */
DataStream.prototype.readString = function(length, encoding) {
  if (encoding == null || encoding == "ASCII") {
    return String.fromCharCode.apply(null, this.mapUint8Array(length == null ? this.byteLength-this.position : length));
  } else {
    return (new TextDecoder(encoding)).decode(this.mapUint8Array(length));
  }
};

/**
  Writes a string of desired length and encoding to the DataStream.

  @param {string} s The string to write.
  @param {?string} encoding The encoding for the written string data.
                            Defaults to ASCII.
  @param {?number} length The number of characters to write.
 */
DataStream.prototype.writeString = function(s, encoding, length) {
  var i = 0;
  if (encoding == null || encoding == "ASCII") {
    if (length != null) {
      var len = Math.min(s.length, length);
      for (i=0; i<len; i++) {
        this.writeUint8(s.charCodeAt(i));
      }
      for (; i<length; i++) {
        this.writeUint8(0);
      }
    } else {
      for (i=0; i<s.length; i++) {
        this.writeUint8(s.charCodeAt(i));
      }
    }
  } else {
    this.writeUint8Array((new TextEncoder(encoding)).encode(s.substring(0, length)));
  }
};


/**
  Read null-terminated string of desired length from the DataStream. Truncates
  the returned string so that the null byte is not a part of it.

  @param {?number} length The length of the string to read.
  @return {string} The read string.
 */
DataStream.prototype.readCString = function(length) {
  var blen = this.byteLength-this.position;
  var u8 = new Uint8Array(this._buffer, this._byteOffset + this.position);
  var len = blen;
  if (length != null) {
    len = Math.min(length, blen);
  }
  for (var i = 0; i < len && u8[i] !== 0; i++); // find first zero byte
  var s = String.fromCharCode.apply(null, this.mapUint8Array(i));
  if (length != null) {
    this.position += len-i;
  } else if (i != blen) {
    this.position += 1; // trailing zero if not at end of buffer
  }
  return s;
};

/**
  Writes a null-terminated string to DataStream and zero-pads it to length
  bytes. If length is not given, writes the string followed by a zero.
  If string is longer than length, the written part of the string does not have
  a trailing zero.

  @param {string} s The string to write.
  @param {?number} length The number of characters to write.
 */
DataStream.prototype.writeCString = function(s, length) {
  var i = 0;
  if (length != null) {
    var len = Math.min(s.length, length);
    for (i=0; i<len; i++) {
      this.writeUint8(s.charCodeAt(i));
    }
    for (; i<length; i++) {
      this.writeUint8(0);
    }
  } else {
    for (i=0; i<s.length; i++) {
      this.writeUint8(s.charCodeAt(i));
    }
    this.writeUint8(0);
  }
};

/**
  Reads an object of type t from the DataStream, passing struct as the thus-far
  read struct to possible callbacks that refer to it. Used by readStruct for
  reading in the values, so the type is one of the readStruct types.

  @param {Object} t Type of the object to read.
  @param {?Object} struct Struct to refer to when resolving length references
                          and for calling callbacks.
  @return {?Object} Returns the object on successful read, null on unsuccessful.
 */
DataStream.prototype.readType = function(t, struct) {
  if (typeof t == "function") {
    return t(this, struct);
  } else if (typeof t == "object" && !(t instanceof Array)) {
    return t.get(this, struct);
  } else if (t instanceof Array && t.length != 3) {
    return this.readStruct(t, struct);
  }
  var v = null;
  var lengthOverride = null;
  var charset = "ASCII";
  var pos = this.position;
  var tp;
  var i;
  var u;
  if (typeof t == 'string' && /:/.test(t)) {
    tp = t.split(":");
    t = tp[0];
    lengthOverride = parseInt(tp[1]);
  }
  if (typeof t == 'string' && /,/.test(t)) {
    tp = t.split(",");
    t = tp[0];
    charset = parseInt(tp[1]);
  }
  switch(t) {

    case 'uint8':
      v = this.readUint8(); break;
    case 'int8':
      v = this.readInt8(); break;

    case 'uint16':
      v = this.readUint16(this.endianness); break;
    case 'int16':
      v = this.readInt16(this.endianness); break;
    case 'uint32':
      v = this.readUint32(this.endianness); break;
    case 'int32':
      v = this.readInt32(this.endianness); break;
    case 'float32':
      v = this.readFloat32(this.endianness); break;
    case 'float64':
      v = this.readFloat64(this.endianness); break;

    case 'uint16be':
      v = this.readUint16(DataStream.BIG_ENDIAN); break;
    case 'int16be':
      v = this.readInt16(DataStream.BIG_ENDIAN); break;
    case 'uint32be':
      v = this.readUint32(DataStream.BIG_ENDIAN); break;
    case 'int32be':
      v = this.readInt32(DataStream.BIG_ENDIAN); break;
    case 'float32be':
      v = this.readFloat32(DataStream.BIG_ENDIAN); break;
    case 'float64be':
      v = this.readFloat64(DataStream.BIG_ENDIAN); break;

    case 'uint16le':
      v = this.readUint16(DataStream.LITTLE_ENDIAN); break;
    case 'int16le':
      v = this.readInt16(DataStream.LITTLE_ENDIAN); break;
    case 'uint32le':
      v = this.readUint32(DataStream.LITTLE_ENDIAN); break;
    case 'int32le':
      v = this.readInt32(DataStream.LITTLE_ENDIAN); break;
    case 'float32le':
      v = this.readFloat32(DataStream.LITTLE_ENDIAN); break;
    case 'float64le':
      v = this.readFloat64(DataStream.LITTLE_ENDIAN); break;

    case 'cstring':
      v = this.readCString(lengthOverride); break;

    case 'string':
      v = this.readString(lengthOverride, charset); break;

    case 'u16string':
      v = this.readUCS2String(lengthOverride, this.endianness); break;

    case 'u16stringle':
      v = this.readUCS2String(lengthOverride, DataStream.LITTLE_ENDIAN); break;

    case 'u16stringbe':
      v = this.readUCS2String(lengthOverride, DataStream.BIG_ENDIAN); break;

    default:
      if (t.length == 3) {
        var ta = t[1];
        var len = t[2];
        var length = 0;
        if (typeof len == 'function') {
          length = len(struct, this, t);
        } else if (typeof len == 'string' && struct[len] != null) {
          length = parseInt(struct[len]);
        } else {
          length = parseInt(len);
        }
        if (typeof ta == "string") {
          var tap = ta.replace(/(le|be)$/, '');
          var endianness = null;
          if (/le$/.test(ta)) {
            endianness = DataStream.LITTLE_ENDIAN;
          } else if (/be$/.test(ta)) {
            endianness = DataStream.BIG_ENDIAN;
          }
          if (len == '*') {
            length = null;
          }
          switch(tap) {
            case 'uint8':
              v = this.readUint8Array(length); break;
            case 'uint16':
              v = this.readUint16Array(length, endianness); break;
            case 'uint32':
              v = this.readUint32Array(length, endianness); break;
            case 'int8':
              v = this.readInt8Array(length); break;
            case 'int16':
              v = this.readInt16Array(length, endianness); break;
            case 'int32':
              v = this.readInt32Array(length, endianness); break;
            case 'float32':
              v = this.readFloat32Array(length, endianness); break;
            case 'float64':
              v = this.readFloat64Array(length, endianness); break;
            case 'cstring':
            case 'utf16string':
            case 'string':
              if (length == null) {
                v = [];
                while (!this.isEof()) {
                  u = this.readType(ta, struct);
                  if (u == null) break;
                  v.push(u);
                }
              } else {
                v = new Array(length);
                for (i=0; i<length; i++) {
                  v[i] = this.readType(ta, struct);
                }
              }
              break;
          }
        } else {
          if (len == '*') {
            v = [];
            var tmp_buffer = this.buffer;
            while (true) {
              var p = this.position;
              try {
                var o = this.readType(ta, struct);
                if (o == null) {
                  this.position = p;
                  break;
                }
                v.push(o);
              } catch(e) {
                this.position = p;
                break;
              }
            }
          } else {
            v = new Array(length);
            for (i=0; i<length; i++) {
              u = this.readType(ta, struct);
              if (u == null) return null;
              v[i] = u;
            }
          }
        }
        break;
      }
  }
  if (lengthOverride != null) {
    this.position = pos + lengthOverride;
  }
  return v;
};

/**
  Writes a struct to the DataStream. Takes a structDefinition that gives the
  types and a struct object that gives the values. Refer to readStruct for the
  structure of structDefinition.

  @param {Object} structDefinition Type definition of the struct.
  @param {Object} struct The struct data object.
  */
DataStream.prototype.writeStruct = function(structDefinition, struct) {
  for (var i = 0; i < structDefinition.length; i+=2) {
    var t = structDefinition[i+1];
    this.writeType(t, struct[structDefinition[i]], struct);
  }
};

/**
  Writes object v of type t to the DataStream.

  @param {Object} t Type of data to write.
  @param {Object} v Value of data to write.
  @param {Object} struct Struct to pass to write callback functions.
  */
DataStream.prototype.writeType = function(t, v, struct) {
  var tp;
  if (typeof t == "function") {
    return t(this, v);
  } else if (typeof t == "object" && !(t instanceof Array)) {
    return t.set(this, v, struct);
  }
  var lengthOverride = null;
  var charset = "ASCII";
  var pos = this.position;
  if (typeof(t) == 'string' && /:/.test(t)) {
    tp = t.split(":");
    t = tp[0];
    lengthOverride = parseInt(tp[1]);
  }
  if (typeof t == 'string' && /,/.test(t)) {
    tp = t.split(",");
    t = tp[0];
    charset = parseInt(tp[1]);
  }

  switch(t) {
    case 'uint8':
      this.writeUint8(v);
      break;
    case 'int8':
      this.writeInt8(v);
      break;

    case 'uint16':
      this.writeUint16(v, this.endianness);
      break;
    case 'int16':
      this.writeInt16(v, this.endianness);
      break;
    case 'uint32':
      this.writeUint32(v, this.endianness);
      break;
    case 'int32':
      this.writeInt32(v, this.endianness);
      break;
    case 'float32':
      this.writeFloat32(v, this.endianness);
      break;
    case 'float64':
      this.writeFloat64(v, this.endianness);
      break;

    case 'uint16be':
      this.writeUint16(v, DataStream.BIG_ENDIAN);
      break;
    case 'int16be':
      this.writeInt16(v, DataStream.BIG_ENDIAN);
      break;
    case 'uint32be':
      this.writeUint32(v, DataStream.BIG_ENDIAN);
      break;
    case 'int32be':
      this.writeInt32(v, DataStream.BIG_ENDIAN);
      break;
    case 'float32be':
      this.writeFloat32(v, DataStream.BIG_ENDIAN);
      break;
    case 'float64be':
      this.writeFloat64(v, DataStream.BIG_ENDIAN);
      break;

    case 'uint16le':
      this.writeUint16(v, DataStream.LITTLE_ENDIAN);
      break;
    case 'int16le':
      this.writeInt16(v, DataStream.LITTLE_ENDIAN);
      break;
    case 'uint32le':
      this.writeUint32(v, DataStream.LITTLE_ENDIAN);
      break;
    case 'int32le':
      this.writeInt32(v, DataStream.LITTLE_ENDIAN);
      break;
    case 'float32le':
      this.writeFloat32(v, DataStream.LITTLE_ENDIAN);
      break;
    case 'float64le':
      this.writeFloat64(v, DataStream.LITTLE_ENDIAN);
      break;

    case 'cstring':
      this.writeCString(v, lengthOverride);
      break;

    case 'string':
      this.writeString(v, charset, lengthOverride);
      break;

    case 'u16string':
      this.writeUCS2String(v, this.endianness, lengthOverride);
      break;

    case 'u16stringle':
      this.writeUCS2String(v, DataStream.LITTLE_ENDIAN, lengthOverride);
      break;

    case 'u16stringbe':
      this.writeUCS2String(v, DataStream.BIG_ENDIAN, lengthOverride);
      break;

    default:
      if (t.length == 3) {
        var ta = t[1];
        for (var i=0; i<v.length; i++) {
          this.writeType(ta, v[i]);
        }
        break;
      } else {
        this.writeStruct(t, v);
        break;
      }
  }
  if (lengthOverride != null) {
    this.position = pos;
    this._realloc(lengthOverride);
    this.position = pos + lengthOverride;
  }
};


/* 
   TODO: fix endianness for 24/64-bit fields
   TODO: check range/support for 64-bits numbers in JavaScript
*/
var MAX_SIZE = Math.pow(2, 32);
exports.MAX_SIZE = MAX_SIZE;

DataStream.prototype.readUint64 = function () {
	return (this.readUint32()*MAX_SIZE)+this.readUint32();
}

DataStream.prototype.writeUint64 = function (v) {
	var h = Math.floor(v / MAX_SIZE);
	this.writeUint32(h);
	this.writeUint32(v & 0xFFFFFFFF);
}

DataStream.prototype.readUint24 = function () {
	return (this.readUint8()<<16)+(this.readUint8()<<8)+this.readUint8();
}

DataStream.prototype.writeUint24 = function (v) {
	this.writeUint8((v & 0x00FF0000)>>16);
	this.writeUint8((v & 0x0000FF00)>>8);
	this.writeUint8((v & 0x000000FF));
}

DataStream.prototype.adjustUint32 = function(position, value) {
	var pos = this.position;
	this.seek(position);
	this.writeUint32(value);
	this.seek(pos);
}
},{}],166:[function(require,module,exports){
/* 
 * Copyright (c) 2012-2013. Telecom ParisTech/TSI/MM/GPAC Cyril Concolato
 * License: BSD-3-Clause (see LICENSE file)
 */
var DataStream = require('./DataStream');
var MPEG4DescriptorParser = require('./descriptor');
var Log = require('./log');
var BoxParser = {
	ERR_NOT_ENOUGH_DATA : 0,
	OK : 1,
	boxCodes : [ 
				 "mdat", 
				 "avcC", "hvcC", "ftyp", 
				 "payl",
				 "vmhd", "smhd", "hmhd", "dref", "elst" // full boxes not yet parsed
			   ],
	fullBoxCodes : [ "mvhd", "tkhd", "mdhd", "hdlr", "smhd", "hmhd", "nhmd", "url ", "urn ", 
				  "ctts", "cslg", "stco", "co64", "stsc", "stss", "stsz", "stz2", "stts", "stsh", 
				  "mehd", "trex", "mfhd", "tfhd", "trun", "tfdt",
				  "esds", "subs",
				  "txtC"
				  /* missing "stsd": special case full box and container */
				],
	containerBoxCodes : [ 
		[ "moov", [ "trak" ] ],
		[ "trak" ],
		[ "edts" ],
		[ "mdia" ],
		[ "minf" ],
		[ "dinf" ],
		[ "stbl" ],
		[ "mvex", [ "trex" ] ],
		[ "moof", [ "traf" ] ],
		[ "traf", [ "trun" ] ],
		[ "vttc" ], 
		[ "tref" ]
	],
	sampleEntryCodes : [ 
		/* 4CC as registered on http://mp4ra.org/codecs.html */
		{ prefix: "Visual", types: [ "mp4v", "avc1", "avc2", "avc3", "avc4", "avcp", "drac", "encv", "mjp2", "mvc1", "mvc2", "resv", "s263", "svc1", "vc-1", "hvc1", "hev1"  ] },
		{ prefix: "Audio", 	types: [ "mp4a", "ac-3", "alac", "dra1", "dtsc", "dtse", ,"dtsh", "dtsl", "ec-3", "enca", "g719", "g726", "m4ae", "mlpa",  "raw ", "samr", "sawb", "sawp", "sevc", "sqcp", "ssmv", "twos" ] },
		{ prefix: "Hint", 	types: [ "fdp ", "m2ts", "pm2t", "prtp", "rm2t", "rrtp", "rsrp", "rtp ", "sm2t", "srtp" ] },
		{ prefix: "Metadata", types: [ "metx", "mett", "urim" ] },
		{ prefix: "Subtitle", types: [ "stpp", "wvtt", "sbtt", "tx3g", "stxt" ] }
	],
	trackReferenceTypes: [
		"scal"
	],
	initialize: function() {
		var i, j;
		var length;
		BoxParser.FullBox.prototype = new BoxParser.Box();
		BoxParser.ContainerBox.prototype = new BoxParser.Box();
		BoxParser.stsdBox.prototype = new BoxParser.FullBox();
		BoxParser.SampleEntry.prototype = new BoxParser.FullBox();
		BoxParser.TrackReferenceTypeBox.prototype = new BoxParser.Box();
		/* creating constructors for simple boxes */
		length = BoxParser.boxCodes.length;
		for (i=0; i<length; i++) {
			BoxParser[BoxParser.boxCodes[i]+"Box"] = (function (j) { /* creating a closure around the iterating value of i */
				return function(size) {
					BoxParser.Box.call(this, BoxParser.boxCodes[j], size);
				}
			})(i);
			BoxParser[BoxParser.boxCodes[i]+"Box"].prototype = new BoxParser.Box();
		}
		/* creating constructors for full boxes */
		length = BoxParser.fullBoxCodes.length;
		for (i=0; i<length; i++) {
			BoxParser[BoxParser.fullBoxCodes[i]+"Box"] = (function (j) { 
				return function(size) {
					BoxParser.FullBox.call(this, BoxParser.fullBoxCodes[j], size);
				}
			})(i);
			BoxParser[BoxParser.fullBoxCodes[i]+"Box"].prototype = new BoxParser.FullBox();
		}
		/* creating constructors for container boxes */
		length = BoxParser.containerBoxCodes.length;
		for (i=0; i<length; i++) {
			BoxParser[BoxParser.containerBoxCodes[i][0]+"Box"] = (function (j, subBoxNames) { 
				return function(size) {
					BoxParser.ContainerBox.call(this, BoxParser.containerBoxCodes[j][0], size);
					if (subBoxNames) {
						this.subBoxNames = subBoxNames;
						var nbSubBoxes = subBoxNames.length;
						for (var k = 0; k<nbSubBoxes; k++) {
							this[subBoxNames[k]+"s"] = [];
						}
					}
				}
			})(i, BoxParser.containerBoxCodes[i][1]);
			BoxParser[BoxParser.containerBoxCodes[i][0]+"Box"].prototype = new BoxParser.ContainerBox();
		}
		/* creating constructors for stsd entries  */
		length = BoxParser.sampleEntryCodes.length;
		for (j = 0; j < length; j++) {
			var prefix = BoxParser.sampleEntryCodes[j].prefix;
			var types = BoxParser.sampleEntryCodes[j].types;
			var nb_types = types.length;
			BoxParser[prefix+"SampleEntry"] = function(type, size) { BoxParser.SampleEntry.call(this, type, size); };
			BoxParser[prefix+"SampleEntry"].prototype = new BoxParser.SampleEntry();
			for (i=0; i<nb_types; i++) {
				BoxParser[types[i]+"Box"] = (function (k, l) { 
					return function(size) {
						BoxParser[BoxParser.sampleEntryCodes[k].prefix+"SampleEntry"].call(this, BoxParser.sampleEntryCodes[k].types[l], size);
					}
				})(j, i);
				BoxParser[types[i]+"Box"].prototype = new BoxParser[prefix+"SampleEntry"]();
			}
		}
		/* creating constructors for track reference type boxes */
		length = BoxParser.trackReferenceTypes.length;
		for (i=0; i<length; i++) {
			BoxParser[BoxParser.trackReferenceTypes[i]+"Box"] = (function (j) { 
				return function(size) {
					BoxParser.TrackReferenceTypeBox.call(this, BoxParser.trackReferenceTypes[j], size);
				}
			})(i);
			BoxParser[BoxParser.trackReferenceTypes[i]+"Box"].prototype = new BoxParser.Box();
		}
	},
	Box: function(_type, _size) {
		this.type = _type;
		this.size = _size;
	},
	FullBox: function(type, size) {
		BoxParser.Box.call(this, type, size);
		this.flags = 0;
		this.version = 0;
	},
	ContainerBox: function(type, size) {
		BoxParser.Box.call(this, type, size);
		this.boxes = [];
	},
	SampleEntry: function(type, size) {
		BoxParser.Box.call(this, type, size);	
		this.boxes = [];
	},
	TrackReferenceTypeBox: function(type, size) {
		BoxParser.Box.call(this, type, size);	
		this.track_ids = [];
	},
	stsdBox: function(size) {
		BoxParser.FullBox.call(this, "stsd", size);
		this.entries = [];
	},
	parseOneBox: function(stream, isSampleEntry) {
		var box;
		var start = stream.position;
		var hdr_size = 0;
		if (stream.byteLength - stream.position < 8) {
			Log.d("BoxParser", "Not enough data in stream to parse the type and size of the box");
			return { code: BoxParser.ERR_NOT_ENOUGH_DATA };
		}
		var size = stream.readUint32();
		var type = stream.readString(4);
		Log.d("BoxParser", "Found box of type "+type+" and size "+size+" at position "+start+" in the current buffer ("+(stream.buffer.fileStart+start)+" in the file)");
		hdr_size = 8;
		// TODO: fix this properly. For now, consider the uuid as part of the body and not the header, which will cause the box to be written back out correctly
		// if (type == "uuid") {
		// 	uuid = stream.readString(16);
		// 	hdr_size += 16;
		// }
		if (size == 1) {
			if (stream.byteLength - stream.position < 8) {
				stream.seek(start);
				Log.w("BoxParser", "Not enough data in stream to parse the extended size of the \""+type+"\" box");
				return { code: BoxParser.ERR_NOT_ENOUGH_DATA };
			}
			size = stream.readUint64();
			hdr_size += 8;
		} else if (size === 0) {
			/* box extends till the end of file */
			throw "Unlimited box size not supported";
		}
		
		if (start + size > stream.byteLength ) {
			stream.seek(start);
			Log.w("BoxParser", "Not enough data in stream to parse the entire \""+type+"\" box");
			return { code: BoxParser.ERR_NOT_ENOUGH_DATA, type: type, size: size, hdr_size: hdr_size };
		}
		if (BoxParser[type+"Box"]) {
			box = new BoxParser[type+"Box"](size - hdr_size);		
		} else {
			if (isSampleEntry) {
				box = new BoxParser.SampleEntry(type, size - hdr_size);
			} else {
				box = new BoxParser.Box(type, size - hdr_size);
			}
		}
		/* recording the position of the box in the input stream */
		box.hdr_size = hdr_size;
		box.start = start;
		box.fileStart = start + stream.buffer.fileStart;
		box.parse(stream);
		stream.seek(start + size);
		return { code: BoxParser.OK, box: box, size: size };
	},
}
module.exports = BoxParser;

BoxParser.initialize();

BoxParser.Box.prototype.parse = function(stream) {
	if (this.type != "mdat") {
		this.data = stream.readUint8Array(this.size);
	} else {
		stream.seek(this.start+this.size+this.hdr_size);
	}
}

BoxParser.FullBox.prototype.parseFullHeader = function (stream) {
	this.version = stream.readUint8();
	this.flags = stream.readUint24();
	this.size -= 4;
}

BoxParser.ContainerBox.prototype.parse = function(stream) {
	var ret;
	var box;
	var start;
	start = stream.position;
	while (stream.position < start+this.size) {
		ret = BoxParser.parseOneBox(stream);
		box = ret.box;
		/* store the box in the 'boxes' array to preserve box order (for offset) but also store box in a property for more direct access */
		this.boxes.push(box);
		if (this.subBoxNames && this.subBoxNames.indexOf(box.type) != -1) {
			this[this.subBoxNames+"s"].push(box);
		} else {
			this[box.type] = box;
		}
	}
}

BoxParser.SampleEntry.prototype.isVideo = function() {
	return false;
}

BoxParser.SampleEntry.prototype.isAudio = function() {
	return false;
}

BoxParser.SampleEntry.prototype.isSubtitle = function() {
	return false;
}

BoxParser.SampleEntry.prototype.isMetadata = function() {
	return false;
}

BoxParser.SampleEntry.prototype.isHint = function() {
	return false;
}

BoxParser.SampleEntry.prototype.getCodec = function() {
	return this.type;
}

BoxParser.SampleEntry.prototype.getWidth = function() {
	return "";
}

BoxParser.SampleEntry.prototype.getHeight = function() {
	return "";
}

BoxParser.SampleEntry.prototype.getChannelCount = function() {
	return "";
}

BoxParser.SampleEntry.prototype.getSampleRate = function() {
	return "";
}

BoxParser.SampleEntry.prototype.getSampleSize = function() {
	return "";
}

BoxParser.SampleEntry.prototype.parseHeader = function(stream) {
	this.start = stream.position;
	stream.readUint8Array(6);
	this.data_reference_index = stream.readUint16();
}

BoxParser.SampleEntry.prototype.parse = function(stream) {
	this.parseHeader(stream);
	stream.seek(this.start+this.size);
}

BoxParser.SampleEntry.prototype.parseFooter = function(stream) {
	var ret;
	var box;
	while (stream.position < this.start+this.size) {
		ret = BoxParser.parseOneBox(stream, false);
		box = ret.box;
		this.boxes.push(box);
		this[box.type] = box;
	}	
}

BoxParser.VisualSampleEntry.prototype.parse = function(stream) {
	this.parseHeader(stream);
	stream.readUint16(); 
	stream.readUint16();
	stream.readUint32Array(3);
	this.width = stream.readUint16();
	this.height = stream.readUint16();
	this.horizresolution = stream.readUint32();
	this.vertresolution = stream.readUint32();
	stream.readUint32();
	this.frame_count = stream.readUint16();
	this.compressorname = stream.readString(32);
	this.depth = stream.readUint16();
	stream.readUint16();
	this.parseFooter(stream);
}

BoxParser.VisualSampleEntry.prototype.isVideo = function() {
	return true;
}

BoxParser.VisualSampleEntry.prototype.getWidth = function() {
	return this.width;
}

BoxParser.VisualSampleEntry.prototype.getHeight = function() {
	return this.height;
}

BoxParser.AudioSampleEntry.prototype.parse = function(stream) {
	this.parseHeader(stream);
	stream.readUint32Array(2);
	this.channel_count = stream.readUint16();
	this.samplesize = stream.readUint16();
	stream.readUint16();
	stream.readUint16();
	this.samplerate = (stream.readUint32()/(1<<16));
	this.parseFooter(stream);
}

BoxParser.AudioSampleEntry.prototype.isAudio = function() {
	return true;
}

BoxParser.AudioSampleEntry.prototype.getChannelCount = function() {
	return this.channel_count;
}

BoxParser.AudioSampleEntry.prototype.getSampleRate = function() {
	return this.samplerate;
}

BoxParser.AudioSampleEntry.prototype.getSampleSize = function() {
	return this.samplesize;
}

BoxParser.SubtitleSampleEntry.prototype.parse = function(stream) {
	this.parseHeader(stream);
	this.parseFooter(stream);
}

BoxParser.SubtitleSampleEntry.prototype.isSubtitle = function() {
	return true;
}

BoxParser.MetadataSampleEntry.prototype.parse = function(stream) {
	this.parseHeader(stream);
	this.parseFooter(stream);
}

BoxParser.MetadataSampleEntry.prototype.isMetadata = function() {
	return true;
}

BoxParser.TrackReferenceTypeBox.prototype.parse = function(stream) {
	this.track_ids = stream.readUint8Array(this.size);
}

BoxParser.metxBox.prototype.parse = function(stream) {
	this.parseHeader(stream);
	this.content_encoding = stream.readCString();
	this.namespace = stream.readCString();
	this.schema_location = stream.readCString();
	this.parseFooter(stream);
}

BoxParser.mettBox.prototype.parse = function(stream) {
	this.parseHeader(stream);
	this.content_encoding = stream.readCString();
	this.mime_format = stream.readCString();
	this.parseFooter(stream);
}

BoxParser.sbttBox.prototype.parse = function(stream) {
	this.parseHeader(stream);
	this.content_encoding = stream.readCString();
	this.mime_format = stream.readCString();
	this.parseFooter(stream);
}

BoxParser.stxtBox.prototype.parse = function(stream) {
	this.parseHeader(stream);
	this.content_encoding = stream.readCString();
	this.mime_format = stream.readCString();
	this.parseFooter(stream);
}

BoxParser.stppBox.prototype.parse = function(stream) {
	this.parseHeader(stream);
	this.namespace = stream.readCString();
	this.schema_location = stream.readCString();
	this.auxiliary_mime_types = stream.readCString();
	this.parseFooter(stream);
}

BoxParser.tx3gBox.prototype.parse = function(stream) {
	this.parseHeader(stream);
	this.displayFlags = stream.readUint32();
	this.horizontal_justification = stream.readInt8();
	this.vertical_justification = stream.readInt8();
	this.bg_color_rgba = stream.readUint8Array(4);
	this.box_record = stream.readInt16Array(4);
	this.style_record = stream.readUint8Array(12);
	this.parseFooter(stream);
}

BoxParser.ftypBox.prototype.parse = function(stream) {
	this.major_brand = stream.readString(4);
	this.minor_version = stream.readUint32();
	this.size -= 8;
	this.compatible_brands = [];
	var i = 0;
	while (this.size>=4) {
		this.compatible_brands[i] = stream.readString(4);
		this.size -= 4;
		i++;
	}
}

BoxParser.mvhdBox.prototype.parse = function(stream) {
	this.flags = 0;
	this.parseFullHeader(stream);
	if (this.version == 1) {
		this.creation_time = stream.readUint64();
		this.modification_time = stream.readUint64();
		this.timescale = stream.readUint32();
		this.duration = stream.readUint64();
	} else {
		this.creation_time = stream.readUint32();
		this.modification_time = stream.readUint32();
		this.timescale = stream.readUint32();
		this.duration = stream.readUint32();
	}
	this.rate = stream.readUint32();
	this.volume = stream.readUint16()>>8;
	stream.readUint16();
	stream.readUint32Array(2);
	this.matrix = stream.readUint32Array(9);
	stream.readUint32Array(6);
	this.next_track_id = stream.readUint32();
}

BoxParser.TKHD_FLAG_ENABLED    = 0x000001;
BoxParser.TKHD_FLAG_IN_MOVIE   = 0x000002;
BoxParser.TKHD_FLAG_IN_PREVIEW = 0x000004;

BoxParser.tkhdBox.prototype.parse = function(stream) {
	this.parseFullHeader(stream);
	if (this.version == 1) {
		this.creation_time = stream.readUint64();
		this.modification_time = stream.readUint64();
		this.track_id = stream.readUint32();
		stream.readUint32();
		this.duration = stream.readUint64();
	} else {
		this.creation_time = stream.readUint32();
		this.modification_time = stream.readUint32();
		this.track_id = stream.readUint32();
		stream.readUint32();
		this.duration = stream.readUint32();
	}
	stream.readUint32Array(2);
	this.layer = stream.readInt16();
	this.alternate_group = stream.readInt16();
	this.volume = stream.readInt16()>>8;
	stream.readUint16();
	this.matrix = stream.readInt32Array(9);
	this.width = stream.readUint32();
	this.height = stream.readUint32();
}

BoxParser.mdhdBox.prototype.parse = function(stream) {
	this.parseFullHeader(stream);
	if (this.version == 1) {
		this.creation_time = stream.readUint64();
		this.modification_time = stream.readUint64();
		this.timescale = stream.readUint32();
		this.duration = stream.readUint64();
	} else {
		this.creation_time = stream.readUint32();
		this.modification_time = stream.readUint32();
		this.timescale = stream.readUint32();
		this.duration = stream.readUint32();
	}
	this.language = stream.readUint16();
	var chars = [];
	chars[0] = (this.language>>10)&0x1F;
	chars[1] = (this.language>>5)&0x1F;
	chars[2] = (this.language)&0x1F;
	this.languageString = String.fromCharCode(chars[0]+0x60, chars[1]+0x60, chars[2]+0x60);
	stream.readUint16();
}

BoxParser.hdlrBox.prototype.parse = function(stream) {
	this.parseFullHeader(stream);
	if (this.version === 0) {
		stream.readUint32();
		this.handler = stream.readString(4);
		stream.readUint32Array(3);
		this.name = stream.readCString();
	} else {
		this.data = stream.readUint8Array(size);
	}
}

BoxParser.stsdBox.prototype.parse = function(stream) {
	var ret;
	var entryCount;
	this.parseFullHeader(stream);
	entryCount = stream.readUint32();
	for (i = 1; i <= entryCount; i++) {
		ret = BoxParser.parseOneBox(stream, true);
		this.entries.push(ret.box);
	}
}

BoxParser.avcCBox.prototype.parse = function(stream) {
	var i;
	var nb_nalus;
	var length;
	this.configurationVersion = stream.readUint8();
	this.AVCProfileIndication = stream.readUint8();
	this.profile_compatibility = stream.readUint8();
	this.AVCLevelIndication = stream.readUint8();
	this.lengthSizeMinusOne = (stream.readUint8() & 0x3);
	nb_nalus = (stream.readUint8() & 0x1F);
	this.size -= 6;
	this.SPS = new Array(nb_nalus); 
	for (i = 0; i < nb_nalus; i++) {
		length = stream.readUint16();
		this.SPS[i] = stream.readUint8Array(length);
		this.size -= 2+length;
	}
	nb_nalus = stream.readUint8();
	this.size--;
	this.PPS = new Array(nb_nalus); 
	for (i = 0; i < nb_nalus; i++) {
		length = stream.readUint16();
		this.PPS[i] = stream.readUint8Array(length);
		this.size -= 2+length;
	}
	if (this.size>0) {
		this.ext = stream.readUint8Array(this.size);
	}
}

BoxParser.hvcCBox.prototype.parse = function(stream) {
	var i;
	var nb_nalus;
	var length;
	var tmp_byte;
	this.configurationVersion = stream.readUint8();
	tmp_byte = stream.readUint8();
	this.general_profile_space = tmp_byte >> 6;
	this.general_tier_flag = (tmp_byte & 0x20) >> 5;
	this.general_profile_idc = (tmp_byte & 0x1F);
	this.general_profile_compatibility = stream.readUint32();
	this.general_constraint_indicator = stream.readUint8Array(6);
	this.general_level_idc = stream.readUint8();
	this.min_spatial_segmentation_idc = stream.readUint16() & 0xFFF;
	this.parallelismType = (stream.readUint8() & 0x3);
	this.chromaFormat = (stream.readUint8() & 0x3);
	this.bitDepthLumaMinus8 = (stream.readUint8() & 0x7);
	this.bitDepthChromaMinus8 = (stream.readUint8() & 0x7);
	this.avgFrameRate = stream.readUint16();
	tmp_byte = stream.readUint8();
	this.constantFrameRate = (tmp_byte >> 6);
	this.numTemporalLayers = (tmp_byte & 0XD) >> 3;
	this.temporalIdNested = (tmp_byte & 0X4) >> 2;
	this.lengthSizeMinusOne = (tmp_byte & 0X3);

	this.nalu_arrays = [];
	numOfArrays = stream.readUint8();
	for (i = 0; i < numOfArrays; i++) {
		var nalu_array = [];
		this.nalu_arrays.push(nalu_array);
		tmp_byte = stream.readUint8()
		nalu_array.completeness = (tmp_byte & 0x80) >> 7;
		nalu_array.nalu_type = tmp_byte & 0x3F;
		numNalus = stream.readUint16();
		for (j = 0; j < numNalus; j++) {
			var nalu = {}
			nalu_array.push(nalu);
			length = stream.readUint16();
			nalu.data   = stream.readUint8Array(length);
		}
	}
}

function decimalToHex(d, padding) {
	var hex = Number(d).toString(16);
	padding = typeof (padding) === "undefined" || padding === null ? padding = 2 : padding;
	while (hex.length < padding) {
		hex = "0" + hex;
	}
	return hex;
}

BoxParser.avc1Box.prototype.getCodec = function() {
	var baseCodec = BoxParser.SampleEntry.prototype.getCodec.call(this);
	if (this.avcC) {
		return baseCodec+"."+decimalToHex(this.avcC.AVCProfileIndication)+
						  ""+decimalToHex(this.avcC.profile_compatibility)+
						  ""+decimalToHex(this.avcC.AVCLevelIndication);		
	} else {
		return baseCodec;
	}
}

BoxParser.hvc1Box.prototype.getCodec = function() {
	var i;
	var baseCodec = BoxParser.SampleEntry.prototype.getCodec.call(this);
	if (this.hvcC) {
		baseCodec += '.';
		switch (this.hvcC.general_profile_space) {
			case 0: 
				baseCodec += '';
				break;
			case 1: 
				baseCodec += 'A';
				break;
			case 2: 
				baseCodec += 'B';
				break;
			case 3: 
				baseCodec += 'C';
				break;
		
		}
		baseCodec += this.hvcC.general_profile_idc;
		baseCodec += '.';
		var val = this.hvcC.general_profile_compatibility;
		var reversed = 0;
		for (i=0; i<32; i++) {
			reversed |= val & 1;
			if (i==31) break;
			reversed <<= 1;
			val >>=1;
		}				
		baseCodec += decimalToHex(reversed, 0);
		baseCodec += '.';
		if (this.hvcC.general_tier_flag === 0) {
			baseCodec += 'L';
		} else {
			baseCodec += 'H';
		}
		baseCodec += this.hvcC.general_level_idc;
		var hasByte = false;
		var constraint_string = "";
		for (i = 5; i >= 0; i--) {
			if (this.hvcC.general_constraint_indicator[i] || hasByte) {
				constraint_string = "."+decimalToHex(this.hvcC.general_constraint_indicator[i], 0)+constraint_string;
				hasByte = true;
			}
		}
		baseCodec += constraint_string;
	} 
	return baseCodec;
}

BoxParser.mp4aBox.prototype.getCodec = function() {
	var baseCodec = BoxParser.SampleEntry.prototype.getCodec.call(this);
	if (this.esds && this.esds.esd) {
		var oti = this.esds.esd.getOTI();
		var dsi = this.esds.esd.getAudioConfig();
		return baseCodec+"."+decimalToHex(oti)+(dsi ? "."+dsi: "");
	} else {
		return baseCodec;
	}
}

BoxParser.esdsBox.prototype.parse = function(stream) {
	this.parseFullHeader(stream);
	this.data = stream.readUint8Array(this.size);
	this.size = 0;
	var esd_parser = new MPEG4DescriptorParser();
	this.esd = esd_parser.parseOneDescriptor(new DataStream(this.data.buffer, 0, DataStream.BIG_ENDIAN));
}

BoxParser.txtCBox.prototype.parse = function(stream) {
	this.parseFullHeader(stream);
	this.config = stream.readCString();
}

BoxParser.cttsBox.prototype.parse = function(stream) {
	var entry_count;
	var i;
	this.parseFullHeader(stream);
	entry_count = stream.readUint32();
	this.sample_counts = [];
	this.sample_offsets = [];
	if (this.version === 0) {
		for(i=0; i<entry_count; i++) {
			this.sample_counts.push(stream.readUint32());
			/* some files are buggy and declare version=0 while using signed offsets. 
			   The likelyhood of using the most significant bit in a 32-bits time offset is very low,
			   so using signed value here as well */ 
			this.sample_offsets.push(stream.readInt32());
		}
	} else if (this.version == 1) {
		for(i=0; i<entry_count; i++) {
			this.sample_counts.push(stream.readUint32());
			this.sample_offsets.push(stream.readInt32()); /* signed */
		}
	} else {
		this.data = stream.readUint8Array(this.size-4);
	}
}

BoxParser.cttsBox.prototype.unpack = function(samples) {
	var i, j, k;
	k = 0;
	for (i = 0; i < this.sample_counts.length; i++) {
		for (j = 0; j < this.sample_counts[i]; j++) {
			samples[k].pts = samples[k].dts + this.sample_offsets[i];
			k++;
		}
	}
}

BoxParser.cslgBox.prototype.parse = function(stream) {
	var entry_count;
	this.parseFullHeader(stream);
	if (this.version === 0) {
		this.compositionToDTSShift = stream.readInt32(); /* signed */
		this.leastDecodeToDisplayDelta = stream.readInt32(); /* signed */
		this.greatestDecodeToDisplayDelta = stream.readInt32(); /* signed */
		this.compositionStartTime = stream.readInt32(); /* signed */
		this.compositionEndTime = stream.readInt32(); /* signed */
	} else {
		this.data = stream.readUint8Array(this.size-4);
	}
}

BoxParser.sttsBox.prototype.parse = function(stream) {
	var entry_count;
	var i;
	this.parseFullHeader(stream);
	entry_count = stream.readUint32();
	this.sample_counts = [];
	this.sample_deltas = [];
	if (this.version === 0) {
		for(i=0; i<entry_count; i++) {
			this.sample_counts.push(stream.readUint32());
			this.sample_deltas.push(stream.readUint32());
		}
	} else {
		this.data = stream.readUint8Array(this.size-4);
	}
}

BoxParser.sttsBox.prototype.unpack = function(samples) {
	var i, j, k;
	k = 0;
	for (i = 0; i < this.sample_counts.length; i++) {
		for (j = 0; j < this.sample_counts[i]; j++) {
			if (k === 0) {
				samples[k].dts = 0;
			} else {
				samples[k].dts = samples[k-1].dts + this.sample_deltas[i];
			}
			k++;
		}
	}
}

BoxParser.stssBox.prototype.parse = function(stream) {
	var entry_count;
	this.parseFullHeader(stream);
	entry_count = stream.readUint32();
	if (this.version === 0) {
		this.sample_numbers = stream.readUint32Array(entry_count);
	} else {
		this.data = stream.readUint8Array(this.size-4);
	}
}

BoxParser.stshBox.prototype.parse = function(stream) {
	var entry_count;
	var i;
	this.parseFullHeader(stream);
	entry_count = stream.readUint32();
	this.shadowed_sample_numbers = [];
	this.sync_sample_numbers = [];
	if (this.version === 0) {
		for(i=0; i<entry_count; i++) {
			this.shadowed_sample_numbers.push(stream.readUint32());
			this.sync_sample_numbers.push(stream.readUint32());
		}
	} else {
		this.data = stream.readUint8Array(this.size-4);
	}
}

BoxParser.stcoBox.prototype.parse = function(stream) {
	var entry_count;
	this.parseFullHeader(stream);
	entry_count = stream.readUint32();
	if (this.version === 0) {
		this.chunk_offsets = stream.readUint32Array(entry_count);
	} else {
		this.data = stream.readUint8Array(this.size-4);
	}
}

BoxParser.stcoBox.prototype.unpack = function(samples) {
	var i;
	for (i = 0; i < this.chunk_offsets.length; i++) {
		samples[i].offset = this.chunk_offsets[i];
	}
}

BoxParser.co64Box.prototype.parse = function(stream) {
	var entry_count;
	var i;
	this.parseFullHeader(stream);
	entry_count = stream.readUint32();
	this.chunk_offsets = [];
	if (this.version === 0) {
		for(i=0; i<entry_count; i++) {
			this.chunk_offsets.push(stream.readUint64());
		}
	} else {
		this.data = stream.readUint8Array(this.size-4);
	}
}

BoxParser.stscBox.prototype.parse = function(stream) {
	var entry_count;
	var i;
	this.parseFullHeader(stream);
	entry_count = stream.readUint32();
	this.first_chunk = [];
	this.samples_per_chunk = [];
	this.sample_description_index = [];
	if (this.version === 0) {
		for(i=0; i<entry_count; i++) {
			this.first_chunk.push(stream.readUint32());
			this.samples_per_chunk.push(stream.readUint32());
			this.sample_description_index.push(stream.readUint32());
		}
	} else {
		this.data = stream.readUint8Array(this.size-4);
	}
}

BoxParser.stscBox.prototype.unpack = function(samples) {
	var i, j, k, l, m;
	l = 0;
	m = 0;
	for (i = 0; i < this.first_chunk.length; i++) {
		for (j = 0; j < (i+1 < this.first_chunk.length ? this.first_chunk[i+1] : Infinity); j++) {
			m++;
			for (k = 0; k < this.samples_per_chunk[i]; k++) {
				if (samples[l]) {
					samples[l].description_index = this.sample_description_index[i];
					samples[l].chunk_index = m;
				} else {
					return;
				}
				l++;
			}			
		}
	}
}

BoxParser.stszBox.prototype.parse = function(stream) {
	var i;
	var sample_size;
	var sample_count;
	this.parseFullHeader(stream);
	this.sample_sizes = [];
	if (this.version === 0) {
		sample_size = stream.readUint32();
		sample_count = stream.readUint32();
		if (sample_size === 0) {
			this.sample_sizes = stream.readUint32Array(sample_count);
		} else {
			this.sample_sizes = [];
			for (i = 0; i < sample_count; i++) {
				this.sample_sizes[i] = sample_size;
			}		
		}
	} else {
		this.data = stream.readUint8Array(this.size);
	}
}

BoxParser.stszBox.prototype.unpack = function(samples) {
	var i;
	for (i = 0; i < this.sample_sizes.length; i++) {
		samples[i].size = this.sample_sizes[i];
	}
}

BoxParser.mehdBox.prototype.parse = function(stream) {
	this.parseFullHeader(stream);
	if (this.version == 1) {
		this.fragment_duration = stream.readUint64();
	} else {
		this.fragment_duration = stream.readUint32();
	}
}

BoxParser.trexBox.prototype.parse = function(stream) {
	this.parseFullHeader(stream);
	this.track_id = stream.readUint32();
	this.default_sample_description_index = stream.readUint32();
	this.default_sample_duration = stream.readUint32();
	this.default_sample_size = stream.readUint32();
	this.default_sample_flags = stream.readUint32();
}

BoxParser.mfhdBox.prototype.parse = function(stream) {
	this.parseFullHeader(stream);
	this.sequence_number = stream.readUint32();
}

BoxParser.TFHD_FLAG_BASE_DATA_OFFSET		= 0x01;
BoxParser.TFHD_FLAG_SAMPLE_DESC			= 0x02;
BoxParser.TFHD_FLAG_SAMPLE_DUR			= 0x08;
BoxParser.TFHD_FLAG_SAMPLE_SIZE			= 0x10;
BoxParser.TFHD_FLAG_SAMPLE_FLAGS			= 0x20;
BoxParser.TFHD_FLAG_DUR_EMPTY			= 0x10000;
BoxParser.TFHD_FLAG_DEFAULT_BASE_IS_MOOF	= 0x20000;

BoxParser.tfhdBox.prototype.parse = function(stream) {
	var readBytes = 0;
	this.parseFullHeader(stream);
	this.track_id = stream.readUint32();
	if (this.size > readBytes && (this.flags & BoxParser.TFHD_FLAG_BASE_DATA_OFFSET)) {
		this.base_data_offset = stream.readUint64();
		readBytes += 8;
	} else {
		this.base_data_offset = 0;
	}
	if (this.size > readBytes && (this.flags & BoxParser.TFHD_FLAG_SAMPLE_DESC)) {
		this.default_sample_description_index = stream.readUint32();
		readBytes += 4;
	} else {
		this.default_sample_description_index = 0;
	}
	if (this.size > readBytes && (this.flags & BoxParser.TFHD_FLAG_SAMPLE_DUR)) {
		this.default_sample_duration = stream.readUint32();
		readBytes += 4;
	} else {
		this.default_sample_duration = 0;
	}
	if (this.size > readBytes && (this.flags & BoxParser.TFHD_FLAG_SAMPLE_SIZE)) {
		this.default_sample_size = stream.readUint32();
		readBytes += 4;
	} else {
		this.default_sample_size = 0;
	}
	if (this.size > readBytes && (this.flags & BoxParser.TFHD_FLAG_SAMPLE_FLAGS)) {
		this.default_sample_flags = stream.readUint32();
		readBytes += 4;
	} else {
		this.default_sample_flags = 0;
	}
}

BoxParser.TRUN_FLAGS_DATA_OFFSET	= 0x01;
BoxParser.TRUN_FLAGS_FIRST_FLAG	= 0x04;
BoxParser.TRUN_FLAGS_DURATION	= 0x100;
BoxParser.TRUN_FLAGS_SIZE		= 0x200;
BoxParser.TRUN_FLAGS_FLAGS		= 0x400;
BoxParser.TRUN_FLAGS_CTS_OFFSET	= 0x800;

BoxParser.trunBox.prototype.parse = function(stream) {
	var readBytes = 0;
	this.parseFullHeader(stream);
	this.sample_count = stream.readUint32();
	readBytes+= 4;
	if (this.size > readBytes && (this.flags & BoxParser.TRUN_FLAGS_DATA_OFFSET) ) {
		this.data_offset = stream.readInt32(); //signed
		readBytes += 4;
	} else {
		this.data_offset = 0;
	}
	if (this.size > readBytes && (this.flags & BoxParser.TRUN_FLAGS_FIRST_FLAG) ) {
		this.first_sample_flags = stream.readUint32();
		readBytes += 4;
	} else {
		this.first_sample_flags = 0;
	}
	this.sample_duration = [];
	this.sample_size = [];
	this.sample_flags = [];
	this.sample_composition_time_offset = [];
	if (this.size > readBytes) {
		for (var i = 0; i < this.sample_count; i++) {
			if (this.flags & BoxParser.TRUN_FLAGS_DURATION) {
				this.sample_duration[i] = stream.readUint32();
			}
			if (this.flags & BoxParser.TRUN_FLAGS_SIZE) {
				this.sample_size[i] = stream.readUint32();
			}
			if (this.flags & BoxParser.TRUN_FLAGS_FLAGS) {
				this.sample_flags[i] = stream.readUint32();
			}
			if (this.flags & BoxParser.TRUN_FLAGS_CTS_OFFSET) {
				if (this.version === 0) {
					this.sample_composition_time_offset[i] = stream.readUint32();
				} else {
					this.sample_composition_time_offset[i] = stream.readInt32(); //signed
				}
			}
		}
	}
}

BoxParser.tfdtBox.prototype.parse = function(stream) {
	this.parseFullHeader(stream);
	if (this.version == 1) {
		this.baseMediaDecodeTime = stream.readUint64();
	} else {
		this.baseMediaDecodeTime = stream.readUint32();
	}
}

BoxParser.paylBox.prototype.parse = function(stream) {
	this.text = stream.readString(this.size);
}

BoxParser.subsBox.prototype.parse = function(stream) {
	var i,j;
	var entry_count;
	var subsample_count;
	this.parseFullHeader(stream);
	entry_count = stream.readUint32();
	this.samples = [];
	for (i = 0; i < entry_count; i++) {
		var sampleInfo = {};
		this.samples[i] = sampleInfo;
		sampleInfo.sample_delta = stream.readUint32();
		sampleInfo.subsamples = [];
		subsample_count = stream.readUint16();
		if (subsample_count>0) {
			for (j = 0; j < subsample_count; j++) {
				var subsample = {};
				sampleInfo.subsamples.push(subsample);
				if (this.version == 1) {
					subsample.size = stream.readUint32();
				} else {
					subsample.size = stream.readUint16();
				}
				subsample.priority = stream.readUint8();
				subsample.discardable = stream.readUint8();
				subsample.reserved = stream.readUint32();
			}
		}
	}
}

BoxParser.Box.prototype.writeHeader = function(stream, msg) {
	this.size += 8;
	if (this.size > DataStream.MAX_SIZE) {
		this.size += 8;
	}
	Log.d("BoxWriter", "Writing box "+this.type+" of size: "+this.size+" at position "+stream.position+(msg || ""));
	if (this.size > DataStream.MAX_SIZE) {
		stream.writeUint32(1);
	} else {
		this.sizePosition = stream.position;
		stream.writeUint32(this.size);
	}
	stream.writeString(this.type, null, 4);
	if (this.size > DataStream.MAX_SIZE) {
		stream.writeUint64(this.size);
	} 
}

BoxParser.FullBox.prototype.writeHeader = function(stream) {
	this.size += 4;
	BoxParser.Box.prototype.writeHeader.call(this, stream, " v="+this.version+" f="+this.flags);
	stream.writeUint8(this.version);
	stream.writeUint24(this.flags);
}

BoxParser.Box.prototype.write = function(stream) {
	if (this.type === "mdat") {
		/* TODO: fix this */
		if (this.data) {
			this.size = this.data.length;
			this.writeHeader(stream);
			stream.writeUint8Array(this.data);
		}
	} else {
		this.size = this.data.length;
		this.writeHeader(stream);
		stream.writeUint8Array(this.data);
	}
}

BoxParser.ContainerBox.prototype.write = function(stream) {
	this.size = 0;
	this.writeHeader(stream);
	for (var i=0; i<this.boxes.length; i++) {
		if (this.boxes[i]) {
			this.boxes[i].write(stream);
			this.size += this.boxes[i].size;
		}
	}
	/* adjusting the size, now that all sub-boxes are known */
	Log.d("BoxWriter", "Adjusting box "+this.type+" with new size "+this.size);
	stream.adjustUint32(this.sizePosition, this.size);
}

BoxParser.TrackReferenceTypeBox.prototype.write = function(stream) {
	this.size = this.track_ids.length*4;
	this.writeHeader(stream);
	stream.writeUint32Array(this.track_ids);
}

BoxParser.ftypBox.prototype.write = function(stream) {
	this.size = 8+4*this.compatible_brands.length;
	this.writeHeader(stream);
	stream.writeString(this.major_brand, null, 4);
	stream.writeUint32(this.minor_version);
	for (var i = 0; i < this.compatible_brands.length; i++) {
		stream.writeString(this.compatible_brands[i], null, 4);
	}
}

BoxParser.mvhdBox.prototype.write = function(stream) {
	this.version = 0;
	this.flags = 0;
	this.size = 23*4+2*2;
	this.writeHeader(stream);
	stream.writeUint32(this.creation_time);
	stream.writeUint32(this.modification_time);
	stream.writeUint32(this.timescale);
	stream.writeUint32(this.duration);
	stream.writeUint32(this.rate);
	stream.writeUint16(this.volume<<8);
	stream.writeUint16(0);
	stream.writeUint32(0);
	stream.writeUint32(0);
	stream.writeUint32Array(this.matrix);
	stream.writeUint32(0);
	stream.writeUint32(0);
	stream.writeUint32(0);
	stream.writeUint32(0);
	stream.writeUint32(0);
	stream.writeUint32(0);
	stream.writeUint32(this.next_track_id);
}

BoxParser.tkhdBox.prototype.write = function(stream) {
	this.version = 0;
	//this.flags = 0;
	this.size = 4*18+2*4;
	this.writeHeader(stream);
	stream.writeUint32(this.creation_time);
	stream.writeUint32(this.modification_time);
	stream.writeUint32(this.track_id);
	stream.writeUint32(0);
	stream.writeUint32(this.duration);
	stream.writeUint32(0);
	stream.writeUint32(0);
	stream.writeInt16(this.layer);
	stream.writeInt16(this.alternate_group);
	stream.writeInt16(this.volume<<8);
	stream.writeUint16(0);
	stream.writeInt32Array(this.matrix);
	stream.writeUint32(this.width);
	stream.writeUint32(this.height);
}

BoxParser.mdhdBox.prototype.write = function(stream) {
	this.size = 4*4+2*2;
	this.flags = 0;
	this.version = 0;
	this.writeHeader(stream);
	stream.writeUint32(this.creation_time);
	stream.writeUint32(this.modification_time);
	stream.writeUint32(this.timescale);
	stream.writeUint32(this.duration);
	stream.writeUint16(this.language);
	stream.writeUint16(0);
}

BoxParser.hdlrBox.prototype.write = function(stream) {
	this.size = 5*4+this.name.length+1;
	this.version = 0;
	this.flags = 0;
	this.writeHeader(stream);
	stream.writeUint32(0);
	stream.writeString(this.handler, null, 4);
	stream.writeUint32(0);
	stream.writeUint32(0);
	stream.writeUint32(0);
	stream.writeCString(this.name);
}

BoxParser.stsdBox.prototype.write = function(stream) {
	var i;
	this.version = 0;
	this.flags = 0;
	this.size = 0;
	this.writeHeader(stream);
	stream.writeUint32(this.entries.length);
	this.size += 4;
	for (i = 0; i < this.entries.length; i++) {
		this.entries[i].write(stream);
		this.size += this.entries[i].size;
	}
	/* adjusting the size, now that all sub-boxes are known */
	Log.d("BoxWriter", "Adjusting box "+this.type+" with new size "+this.size);
	stream.adjustUint32(this.sizePosition, this.size);
}

BoxParser.SampleEntry.prototype.writeHeader = function(stream) {
	this.size = 8;
	BoxParser.Box.prototype.writeHeader.call(this, stream);
	stream.writeUint8(0);
	stream.writeUint8(0);
	stream.writeUint8(0);
	stream.writeUint8(0);
	stream.writeUint8(0);
	stream.writeUint8(0);
	stream.writeUint16(this.data_reference_index);
}

BoxParser.SampleEntry.prototype.writeFooter = function(stream) {
	for (var i=0; i<this.boxes.length; i++) {
		this.boxes[i].write(stream);
		this.size += this.boxes[i].size;
	}
	Log.d("BoxWriter", "Adjusting box "+this.type+" with new size "+this.size);
	stream.adjustUint32(this.sizePosition, this.size);	
}

BoxParser.SampleEntry.prototype.write = function(stream) {
	this.writeHeader(stream);
	this.writeFooter(stream);
}

BoxParser.VisualSampleEntry.prototype.write = function(stream) {
	this.writeHeader(stream);
	this.size += 2*7+6*4+32;
	stream.writeUint16(0); 
	stream.writeUint16(0);
	stream.writeUint32(0);
	stream.writeUint32(0);
	stream.writeUint32(0);
	stream.writeUint16(this.width - this.width % 2);
	stream.writeUint16(this.height - this.height % 2);
	stream.writeUint32(this.horizresolution);
	stream.writeUint32(this.vertresolution);
	stream.writeUint32(0);
	stream.writeUint16(this.frame_count);
	stream.writeString(this.compressorname, null, 32);
	stream.writeUint16(this.depth);
	stream.writeInt16(-1);
	this.writeFooter(stream);
}

BoxParser.AudioSampleEntry.prototype.write = function(stream) {
	this.writeHeader(stream);
	this.size += 2*4+3*4;
	stream.writeUint32(0);
	stream.writeUint32(0);
	stream.writeUint16(this.channel_count);
	stream.writeUint16(this.samplesize);
	stream.writeUint16(0);
	stream.writeUint16(0);
	stream.writeUint32(this.samplerate<<16);
	this.writeFooter(stream);
}

BoxParser.avcCBox.prototype.write = function(stream) {
	var i;
	this.size = 7;
	for (i = 0; i < this.SPS.length; i++) {
		this.size += 2+this.SPS[i].length;
	}
	for (i = 0; i < this.PPS.length; i++) {
		this.size += 2+this.PPS[i].length;
	}
	if (this.ext) {
		this.size += this.ext.length;
	}
	this.writeHeader(stream);
	stream.writeUint8(this.configurationVersion);
	stream.writeUint8(this.AVCProfileIndication);
	stream.writeUint8(this.profile_compatibility);
	stream.writeUint8(this.AVCLevelIndication);
	stream.writeUint8(this.lengthSizeMinusOne + (63<<2));
	stream.writeUint8(this.SPS.length + (7<<5));
	for (i = 0; i < this.SPS.length; i++) {
		stream.writeUint16(this.SPS[i].length);
		stream.writeUint8Array(this.SPS[i]);
	}
	stream.writeUint8(this.PPS.length);
	for (i = 0; i < this.PPS.length; i++) {
		stream.writeUint16(this.PPS[i].length);
		stream.writeUint8Array(this.PPS[i]);
	}	
	if (this.ext) {
		stream.writeUint8Array(this.ext);
	}
}

BoxParser.cttsBox.prototype.write = function(stream) {
	var i;
	this.version = 1;
	this.flags = 0;
	this.size = 4+8*this.sample_counts.length;
	this.writeHeader(stream);
	stream.writeUint32(this.sample_counts.length);
	for(i=0; i<this.sample_counts.length; i++) {
		stream.writeUint32(this.sample_counts[i]);
		stream.writeInt32(this.sample_offsets[i]); /* signed */
	}
}

BoxParser.cslgBox.prototype.write = function(stream) {
	var i;
	this.version = 0;
	this.flags = 0;
	this.size = 4*5;
	this.writeHeader(stream);
	stream.writeInt32(this.compositionToDTSShift);
	stream.writeInt32(this.leastDecodeToDisplayDelta);
	stream.writeInt32(this.greatestDecodeToDisplayDelta);
	stream.writeInt32(this.compositionStartTime);
	stream.writeInt32(this.compositionEndTime);
}

BoxParser.sttsBox.prototype.write = function(stream) {
	var i;
	this.version = 0;
	this.flags = 0;
	this.size = 4+8*this.sample_counts.length;
	this.writeHeader(stream);
	stream.writeUint32(this.sample_counts.length);
	for(i=0; i<this.sample_counts.length; i++) {
		stream.writeUint32(this.sample_counts[i]);
		stream.writeUint32(this.sample_deltas[i]);
	}
}

BoxParser.stssBox.prototype.write = function(stream) {
	this.version = 0;
	this.flags = 0;
	this.size = 4+4*this.sample_numbers.length;
	this.writeHeader(stream);
	stream.writeUint32(this.sample_numbers.length);
	stream.writeUint32Array(this.sample_numbers);
}

BoxParser.stshBox.prototype.write = function(stream) {
	var i;
	this.version = 0;
	this.flags = 0;
	this.size = 4+8*this.shadowed_sample_numbers.length;
	this.writeHeader(stream);
	stream.writeUint32(this.shadowed_sample_numbers.length);
	for(i=0; i<this.shadowed_sample_numbers.length; i++) {
		stream.writeUint32(this.shadowed_sample_numbers[i]);
		stream.writeUint32(this.sync_sample_numbers[i]);
	}
}

BoxParser.stcoBox.prototype.write = function(stream) {
	this.version = 0;
	this.flags = 0;
	this.size = 4+4*this.chunk_offsets.length;
	this.writeHeader(stream);
	stream.writeUint32(this.chunk_offsets.length);
	stream.writeUint32Array(this.chunk_offsets);
}

BoxParser.co64Box.prototype.write = function(stream) {
	var i;
	this.version = 0;
	this.flags = 0;
	this.size = 4+8*this.chunk_offsets.length;
	this.writeHeader(stream);
	stream.writeUint32(this.chunk_offsets.length);
	for(i=0; i<this.chunk_offsets.length; i++) {
		stream.writeUint64(this.chunk_offsets[i]);
	}
}

BoxParser.stscBox.prototype.write = function(stream) {
	var i;
	this.version = 0;
	this.flags = 0;
	this.size = 4+12*this.first_chunk.length;
	this.writeHeader(stream);
	stream.writeUint32(this.first_chunk.length);
	for(i=0; i<this.first_chunk.length; i++) {
		stream.writeUint32(this.first_chunk[i]);
		stream.writeUint32(this.samples_per_chunk[i]);
		stream.writeUint32(this.sample_description_index[i]);
	}
}

BoxParser.stszBox.prototype.write = function(stream) {
	var i;
	this.version = 0;
	this.flags = 0;
	this.size = 8+12*this.sample_sizes.length;
	this.writeHeader(stream);
	stream.writeUint32(0);
	stream.writeUint32(this.sample_sizes.length);
	stream.writeUint32Array(this.sample_sizes);
}

BoxParser.mehdBox.prototype.write = function(stream) {
	this.version = 0;
	this.flags = 0;
	this.size = 4;
	this.writeHeader(stream);
	stream.writeUint32(this.fragment_duration);
}

BoxParser.trexBox.prototype.write = function(stream) {
	this.version = 0;
	this.flags = 0;
	this.size = 4*5;
	this.writeHeader(stream);
	stream.writeUint32(this.track_id);
	stream.writeUint32(this.default_sample_description_index);
	stream.writeUint32(this.default_sample_duration);
	stream.writeUint32(this.default_sample_size);
	stream.writeUint32(this.default_sample_flags);
}

BoxParser.mfhdBox.prototype.write = function(stream) {
	this.version = 0;
	this.flags = 0;
	this.size = 4;
	this.writeHeader(stream);
	stream.writeUint32(this.sequence_number);
}

BoxParser.tfhdBox.prototype.write = function(stream) {
	this.version = 0;
	this.size = 4;
	if (this.flags & BoxParser.TFHD_FLAG_BASE_OFFSET) {
		this.size += 8;
	}
	if (this.flags & BoxParser.TFHD_FLAG_SAMPLE_DESC) {
		this.size += 4;
	}
	if (this.flags & BoxParser.TFHD_FLAG_SAMPLE_DUR) {
		this.size += 4;
	}
	if (this.flags & BoxParser.TFHD_FLAG_SAMPLE_SIZE) {
		this.size += 4;
	}
	if (this.flags & BoxParser.TFHD_FLAG_SAMPLE_FLAGS) {
		this.size += 4;
	}
	this.writeHeader(stream);
	stream.writeUint32(this.track_id);
	if (this.flags & BoxParser.TFHD_FLAG_BASE_OFFSET) {
		stream.writeUint64(this.base_data_offset);
	}
	if (this.flags & BoxParser.TFHD_FLAG_SAMPLE_DESC) {
		stream.writeUint32(this.default_sample_description_index);
	}
	if (this.flags & BoxParser.TFHD_FLAG_SAMPLE_DUR) {
		stream.writeUint32(this.default_sample_duration);
	}
	if (this.flags & BoxParser.TFHD_FLAG_SAMPLE_SIZE) {
		stream.writeUint32(this.default_sample_size);
	}
	if (this.flags & BoxParser.TFHD_FLAG_SAMPLE_FLAGS) {
		stream.writeUint32(this.default_sample_flags);
	}
}

BoxParser.trunBox.prototype.write = function(stream) {
	this.version = 0;
	this.size = 4;
	if (this.flags & BoxParser.TRUN_FLAGS_DATA_OFFSET) {
		this.size += 4;
	}
	if (this.flags & BoxParser.TRUN_FLAGS_FIRST_FLAG) {
		this.size += 4;
	}
	if (this.flags & BoxParser.TRUN_FLAGS_DURATION) {
		this.size += 4*this.sample_duration.length;
	}
	if (this.flags & BoxParser.TRUN_FLAGS_SIZE) {
		this.size += 4*this.sample_size.length;
	}
	if (this.flags & BoxParser.TRUN_FLAGS_FLAGS) {
		this.size += 4*this.sample_flags.length;
	}
	if (this.flags & BoxParser.TRUN_FLAGS_CTS_OFFSET) {
		this.size += 4*this.sample_composition_time_offset.length;
	}
	this.writeHeader(stream);
	stream.writeUint32(this.sample_count);
	if (this.flags & BoxParser.TRUN_FLAGS_DATA_OFFSET) {
		this.data_offset_position = stream.position;
		stream.writeInt32(this.data_offset); //signed
	}
	if (this.flags & BoxParser.TRUN_FLAGS_FIRST_FLAG) {
		stream.writeUint32(this.first_sample_flags);
	}
	for (var i = 0; i < this.sample_count; i++) {
		if (this.flags & BoxParser.TRUN_FLAGS_DURATION) {
			stream.writeUint32(this.sample_duration[i]);
		}
		if (this.flags & BoxParser.TRUN_FLAGS_SIZE) {
			stream.writeUint32(this.sample_size[i]);
		}
		if (this.flags & BoxParser.TRUN_FLAGS_FLAGS) {
			stream.writeUint32(this.sample_flags[i]);
		}
		if (this.flags & BoxParser.TRUN_FLAGS_CTS_OFFSET) {
			if (this.version === 0) {
				stream.writeUint32(this.sample_composition_time_offset[i]);
			} else {
				stream.writeInt32(this.sample_composition_time_offset[i]); //signed
			}
		}
	}		
}

BoxParser.tfdtBox.prototype.write = function(stream) {
	this.version = 0;
	this.flags = 0;
	this.size = 4;
	this.writeHeader(stream);
	if (this.version == 1) {
		stream.writeUint64(this.baseMediaDecodeTime);
	} else {
		stream.writeUint32(this.baseMediaDecodeTime); 
	}
}

},{"./DataStream":165,"./descriptor":167,"./log":169}],167:[function(require,module,exports){
/* 
 * Copyright (c) 2012-2013. Telecom ParisTech/TSI/MM/GPAC Cyril Concolato
 * License: BSD-3-Clause (see LICENSE file)
 */
var Log = require('./log');
var MPEG4DescriptorParser = function () {
	var ES_DescrTag 			= 0x03;
	var DecoderConfigDescrTag 	= 0x04;
	var DecSpecificInfoTag 		= 0x05;
	var SLConfigDescrTag 		= 0x06;

	var descTagToName = [];
	descTagToName[ES_DescrTag] 				= "ES_Descriptor";
	descTagToName[DecoderConfigDescrTag] 	= "DecoderConfigDescriptor";
	descTagToName[DecSpecificInfoTag] 		= "DecoderSpecificInfo";
	descTagToName[SLConfigDescrTag] 		= "SLConfigDescriptor";

	var that = this;
	var classes = {};
		
	this.parseOneDescriptor = function (stream) {
		var hdrSize = 0;
		var size = 0;
		var tag;
		var desc;
		var byteRead;
		tag = stream.readUint8();
		hdrSize++;
		byteRead = stream.readUint8();
		hdrSize++;
		while (byteRead & 0x80) {		
			size = (byteRead & 0x7F)<<7;
			byteRead = stream.readUint8();
			hdrSize++;
		} 
		size += byteRead & 0x7F;
		Log.d("MPEG4DescriptorParser", "Found "+(descTagToName[tag] | "Descriptor "+tag)+", size "+size+" at position "+stream.position);
		if (descTagToName[tag]) {
			desc = new classes[descTagToName[tag]](size);
		} else {
			desc = new classes.Descriptor(size);
		}
		desc.parse(stream);
		return desc;
	}

	classes.Descriptor = function(_tag, _size) {
		this.tag = _tag;
		this.size = _size;
		this.descs = [];
	}

	classes.Descriptor.prototype.parse = function (stream) {
		this.data = stream.readUint8Array(this.size);
	}

	classes.Descriptor.prototype.findDescriptor = function (tag) {
		for (var i = 0; i < this.descs.length; i++) {
			if (this.descs[i].tag == tag) {
				return this.descs[i];
			}
		}
		return null;
	}

	classes.Descriptor.prototype.parseRemainingDescriptors = function (stream) {
		var start = stream.position;
		while (stream.position < start+this.size) {
			var desc = that.parseOneDescriptor(stream);
			this.descs.push(desc);
		}
	}

	classes.ES_Descriptor = function (size) {
		classes.Descriptor.call(this, ES_DescrTag, size);
	}
	
	classes.ES_Descriptor.prototype = new classes.Descriptor();

	classes.ES_Descriptor.prototype.parse = function(stream) {
		this.ES_ID = stream.readUint16();
		this.flags = stream.readUint8();
		this.size -= 3;
		if (this.flags & 0x80) {
			this.dependsOn_ES_ID = stream.readUint16();
			this.size -= 2;
		} else {
			this.dependsOn_ES_ID = 0;
		}
		if (this.flags & 0x40) {
			var l = stream.readUint8();
			this.URL = stream.readString(l);
			this.size -= l+1;
		} else {
			this.URL = null;
		}
		if (this.flags & 0x20) {
			this.OCR_ES_ID = stream.readUint16();
			this.size -= 2;
		} else {
			this.OCR_ES_ID = 0;
		}
		this.parseRemainingDescriptors(stream);
	}
	
	classes.ES_Descriptor.prototype.getOTI = function(stream) {
		var dcd = this.findDescriptor(DecoderConfigDescrTag);
		if (dcd) {
			return dcd.oti;
		} else {
			return 0;
		}
	}

	classes.ES_Descriptor.prototype.getAudioConfig = function(stream) {
		var dcd = this.findDescriptor(DecoderConfigDescrTag);
		if (!dcd) return null;
		var dsi = dcd.findDescriptor(DecSpecificInfoTag);
		if (dsi && dsi.data) {
			return (dsi.data[0]& 0xF8) >> 3;
		} else {
			return null;
		}
	}
	
	classes.DecoderConfigDescriptor = function (size) {
		classes.Descriptor.call(this, DecoderConfigDescrTag, size);
	}	
	classes.DecoderConfigDescriptor.prototype = new classes.Descriptor();

	classes.DecoderConfigDescriptor.prototype.parse = function(stream) {
		this.oti = stream.readUint8();
		this.streamType = stream.readUint8();
		this.bufferSize = stream.readUint24();
		this.maxBitrate = stream.readUint32();
		this.avgBitrate = stream.readUint32();
		this.size -= 13;
		this.parseRemainingDescriptors(stream);
	}

	classes.DecoderSpecificInfo = function (size) {
		classes.Descriptor.call(this, DecSpecificInfoTag, size);
	}
	classes.DecoderSpecificInfo.prototype = new classes.Descriptor();

	classes.SLConfigDescriptor = function (size) {
		classes.Descriptor.call(this, SLConfigDescrTag, size);
	}
	classes.SLConfigDescriptor.prototype = new classes.Descriptor();
	
	return this;
}
module.exports = MPEG4DescriptorParser;

},{"./log":169}],168:[function(require,module,exports){
/* 
 * Copyright (c) 2012-2013. Telecom ParisTech/TSI/MM/GPAC Cyril Concolato
 * License: BSD-3-Clause (see LICENSE file)
 */
var BoxParser = require('./box');
var DataStream = require('./DataStream');
var Log = require('./log');
var ISOFile = function (stream) {
	/* DataStream object (extended with multiple underlying buffers) used to parse boxes */
	this.stream = stream;
	/* Array of all boxes (in order) found in the file */
	this.boxes = [];
	/* Array of all mdats */
	this.mdats = [];
	/* Array of all moofs */
	this.moofs = [];
	/* Boolean indicating if the file is compatible with progressive parsing (moov first) */
	this.isProgressive = false;
	/* Index of the last moof box received */
	this.lastMoofIndex = 0;
	/* position in the current buffer of the beginning of the last box parsed */
	this.lastBoxStartPosition = 0;
	/* indicator if the parsing is stuck in the middle of an mdat box */
	this.parsingMdat = null;
	/* Boolean used to fire moov start event only once */
	this.moovStartFound = false;
	/* size of the buffers allocated for samples */
	this.samplesDataSize = 0;
	/* next file position that the parser needs:
	    - 0 until the first buffer (i.e. fileStart ===0) has been received 
	    - otherwise, the next box start until the moov box has been parsed
	    - otherwise, the position of the next sample to fetch
	 */
	this.nextParsePosition = 0;
}
module.exports = ISOFile;

ISOFile.prototype.mergeNextBuffer = function() {
	var next_buffer;
	if (this.stream.bufferIndex+1 < this.stream.nextBuffers.length) {
		next_buffer = this.stream.nextBuffers[this.stream.bufferIndex+1];
		if (next_buffer.fileStart === this.stream.buffer.fileStart + this.stream.buffer.byteLength) {
			var oldLength = this.stream.buffer.byteLength;
			var oldUsedBytes = this.stream.buffer.usedBytes;
			var oldFileStart = this.stream.buffer.fileStart;
			this.stream.nextBuffers[this.stream.bufferIndex] = ArrayBuffer.concat(this.stream.buffer, next_buffer);
			this.stream.buffer = this.stream.nextBuffers[this.stream.bufferIndex];
			this.stream.nextBuffers.splice(this.stream.bufferIndex+1, 1);
			this.stream.buffer.usedBytes = oldUsedBytes; /* TODO: should it be += ? */
			this.stream.buffer.fileStart = oldFileStart;
			Log.d("ISOFile", "Concatenating buffer for box parsing (length: "+oldLength+"->"+this.stream.buffer.byteLength+")");
			return true;
		} else {
			return false;
		}
	} else {
		return false;
	}
}

ISOFile.prototype.parse = function() {
	var found;
	var ret;
	var box;
	
	Log.d("ISOFile","Starting parsing with buffer #"+this.stream.bufferIndex+" (fileStart: "+this.stream.buffer.fileStart+" - Length: "+this.stream.buffer.byteLength+") from position "+this.lastBoxStartPosition+
		" ("+(this.stream.buffer.fileStart+this.lastBoxStartPosition)+" in the file)");

	/* Reposition at the start position of the previous box not entirely parsed */
	this.stream.seek(this.lastBoxStartPosition);

	while (true) {
		
		if (this.parsingMdat !== null) {
			/* we are in the parsing of an incomplete mdat box */
			box = this.parsingMdat;

			found = this.reposition(false, box.fileStart + box.hdr_size + box.size);
			if (found) {
				Log.d("ISOFile", "Found 'mdat' end in buffer #"+this.stream.bufferIndex);
				/* the end of the mdat has been found */ 
				this.parsingMdat = null;
				/* we can parse more in this buffer */
				continue;
			} else {
				/* we don't have the end of this mdat yet, 
				   indicate that the next byte to fetch is the end of the buffers we have so far, 
				   return and wait for more buffer to come */
				this.nextParsePosition = this.findEndContiguousBuf(this.stream.bufferIndex);
				return;
			}
		} else {
			/* not parsing an 'mdat' box
			/* remember the position of the box start in case we need to roll back (if the box is incomplete) */
			this.lastBoxStartPosition = this.stream.position;
			ret = BoxParser.parseOneBox(this.stream);
			if (ret.code === BoxParser.ERR_NOT_ENOUGH_DATA) {		
				/* we did not have enough bytes in the current buffer to parse the entire box */
				if (ret.type === "mdat") { 
					/* we had enough bytes to get its type and size and it's an 'mdat' */
					
					/* special handling for mdat boxes, since we don't actually need to parse it linearly 
					   we create the box */
					box = new BoxParser[ret.type+"Box"](ret.size-ret.hdr_size);	
					this.parsingMdat = box;
					this.mdats.push(box);			
					box.fileStart = this.stream.buffer.fileStart + this.stream.position;
					box.hdr_size = ret.hdr_size;
					this.stream.buffer.usedBytes += ret.hdr_size;
					
					/* let's see if we have the end of the box in the other buffers */
					found = this.reposition(false, box.fileStart + box.hdr_size + box.size);
					if (found) {
						/* found the end of the box */
						this.parsingMdat = null;
						/* let's see if we can parse more in this buffer */
						continue;
					} else {
						/* 'mdat' end not found in the existing buffers */
						/* determine the next position in the file to start parsing from */
						if (!this.moovStartFound) {
							/* moov not find yet, 
							   the file probably has 'mdat' at the beginning, and 'moov' at the end, 
							   indicate that the downloader should not try to download those bytes now */
							this.nextParsePosition = box.fileStart + box.size + box.hdr_size;
						} else {
							/* we have the start of the moov box, 
							   the next bytes should try to complete the current 'mdat' */
							this.nextParsePosition = this.findEndContiguousBuf(this.stream.bufferIndex);
						}
						/* not much we can do, wait for more buffers to arrive */
						return;
					}
				} else {
					/* box is incomplete, we may not even know its type */
					if (ret.type === "moov") { 
						/* the incomplete box is a 'moov' box */
						this.moovStartFound = true;
						if (this.mdats.length === 0) {
							this.isProgressive = true;
						}
					} else if (ret.type === 'free') {
						found = this.reposition(false, this.stream.buffer.fileStart + this.stream.position + ret.size);
						if (found) {
							/* found the end of the box */
							/* let's see if we can parse more in this buffer */
							continue;
						} else {
							this.nextParsePosition = this.stream.buffer.fileStart + this.stream.position + ret.size;
							return;
						}
					}
					/* either it's not an mdat box (and we need to parse it, we cannot skip it)
					   (TODO: we could skip 'free' boxes ...)
  					   or we did not have enough data to parse the type and size of the box, 
					   we try to concatenate the current buffer with the next buffer to restart parsing */
					merged = this.mergeNextBuffer();
					if (merged) {
						/* The next buffer was contiguous, the merging succeeded,
						   we can now continue parsing, 
						   the next best position to parse is at the end of this new buffer */
						this.nextParsePosition = this.stream.buffer.fileStart + this.stream.buffer.byteLength;
						continue;
					} else {
						/* we cannot concatenate existing buffers because they are not contiguous or because there is no additional buffer */
						/* The next best position to parse is still at the end of this old buffer */
						if (!ret.type) {
							/* There were not enough bytes in the buffer to parse the box type and length,
							   the next fetch should retrieve those missing bytes, i.e. the next bytes after this buffer */
							this.nextParsePosition = this.stream.buffer.fileStart + this.stream.buffer.byteLength;
						} else {
							/* we had enough bytes to parse size and type of the incomplete box
							   if we haven't found yet the moov box, skip this one and try the next one 
							   if we have found the moov box, let's continue linear parsing */
							if (this.moovStartFound) {
								this.nextParsePosition = this.stream.buffer.fileStart + this.stream.buffer.byteLength;
							} else {
								this.nextParsePosition = this.stream.buffer.fileStart + this.stream.position + ret.size;
							}
						}
						return;
					}
				}
			} else {
				/* the box is entirely parsed */
				box = ret.box;
				/* store the box in the 'boxes' array to preserve box order (for file rewrite if needed)  */
				this.boxes.push(box);
				/* but also store box in a property for more direct access */
				switch (box.type) {
					case "mdat":
						this.mdats.push(box);
						/* remember the position in the file of this box for comparison with sample offsets */
						box.fileStart = this.stream.buffer.fileStart + box.start;
						break;
					case "moof":
						this.moofs.push(box);
						break;
					case "moov":					
						this.moovStartFound = true;
						if (this.mdats.length === 0) {
							this.isProgressive = true;
						}
						/* no break */
						/* falls through */
					default:
						if (this[box.type] !== undefined) {
							Log.w("ISOFile", "Duplicate Box of type: "+box.type+", overriding previous occurrence");
						}
						this[box.type] = box;
						break;
				}
				if (box.type === "mdat") {
					/* for an mdat box, only its header is considered used, other bytes will be used when sample data is requested */
					this.stream.buffer.usedBytes += box.hdr_size;
				} else {
					/* for all other boxes, the entire box data is considered used */
					this.stream.buffer.usedBytes += ret.size;
				}
			}
		}
	}
}

/* Searches for the buffer containing the given file position:
  - if found, repositions the parsing from there and returns true 
  - if not found, does not change anything and returns false */
ISOFile.prototype.reposition = function(fromStart, filePosition) {
	var index;
	index = this.findPosition(fromStart, filePosition);
	if (index !== -1) {
		this.stream.buffer = this.stream.nextBuffers[index];
		this.stream.bufferIndex = index;
		this.stream.position = filePosition - this.stream.buffer.fileStart;
		Log.d("ISOFile", "Repositioning parser at buffer position: "+this.stream.position);
		return true;
	} else {
		return false;
	}
}

/* Searches for the buffer containing the given file position
   Returns the index of the buffer (-1 if not found) */
ISOFile.prototype.findPosition = function(fromStart, filePosition) {
	var i;
	var buffer = null;
	var index = -1;

	/* find the buffer with the largest position smaller than the given position */
	if (fromStart === true) {
	   /* the reposition can be in the past, we need to check from the beginning of the list of buffers */
		i = 0;
	} else {
		i = this.stream.bufferIndex;
	}

	while (i < this.stream.nextBuffers.length) {
		buffer = this.stream.nextBuffers[i];
		if (buffer.fileStart <= filePosition) {
			index = i;
		} else {
			break;
		}
		i++;
	}

	if (index !== -1) {
		buffer = this.stream.nextBuffers[index];
		if (buffer.fileStart + buffer.byteLength >= filePosition) {			
			Log.d("ISOFile", "Found position in existing buffer #"+index);
			return index;
		} else {
			return -1;
		}
	} else {
		return -1;
	}
}

ISOFile.prototype.findEndContiguousBuf = function(index) {
	var i;
	var currentBuf;
	var nextBuf;
	currentBuf = this.stream.nextBuffers[index];
	/* find the end of the contiguous range of data */
	if (this.stream.nextBuffers.length > index+1) {
		for (i = index+1; i < this.stream.nextBuffers.length; i++) {
			nextBuf = this.stream.nextBuffers[i];
			if (nextBuf.fileStart === currentBuf.fileStart + currentBuf.byteLength) {
				currentBuf = nextBuf;
			} else {
				break;
			}
		}
	}
	/* return the position of last byte in the file that we have */
	return currentBuf.fileStart + currentBuf.byteLength;
}

/* Rewrite the entire file */
ISOFile.prototype.write = function(outstream) {
	for (var i=0; i<this.boxes.length; i++) {
		this.boxes[i].write(outstream);
	}
}

/* Modify the file and create the initialization segment */
ISOFile.prototype.writeInitializationSegment = function(outstream) {
	var i;
	var index;
	var mehd;
	var trex;
	var box;
	Log.d("ISOFile", "Generating initialization segment");
	/* write the ftyp box as is in the input, may need to be fixed for DASH brands ?*/
	this.ftyp.write(outstream);

	/* The input file may be fragmented and have an mvex box, we just retrieve the duration and delele that box  */
	if (this.moov.mvex) {
		this.initial_duration = this.moov.mvex.mehd.fragment_duration;
		/* find this mvex box in the array of boxes and remove it */
		index = -1;
		for (i = 0; i < this.moov.boxes.length; i++) {
			box = this.moov.boxes[i];
			if (box === this.moov.mvex) {
				index = i;
			}
		}
		if (index > -1) {
			this.moov.boxes.splice(index, 1);
		}
		this.moov.mvex = null;
	}
	/* we can now create the new mvex box */
	this.moov.mvex = new BoxParser.mvexBox();
	this.moov.boxes.push(this.moov.mvex);
	this.moov.mvex.mehd = new BoxParser.mehdBox();
	this.moov.mvex.boxes.push(this.moov.mvex.mehd);
	this.moov.mvex.mehd.fragment_duration = this.initial_duration; // restore the same duration
	for (i = 0; i < this.moov.traks.length; i++) {
		if (this.moov.traks[i].ignore) continue;
		trex = new BoxParser.trexBox();
		this.moov.mvex.boxes.push(trex);
		trex.track_id = this.moov.traks[i].tkhd.track_id;
		trex.default_sample_description_index = 1;
		trex.default_sample_duration = (this.moov.traks[i].samples.length>0 ? this.moov.traks[i].samples[0].duration: 0);
		trex.default_sample_size = 0;
		trex.default_sample_flags = 1<<16;
	}
	this.moov.write(outstream);
}

/* Resets all sample tables */
ISOFile.prototype.resetTables = function () {
	var i;
	var trak, stco, stsc, stsz, stts, ctts, stss, sdtp;
	this.initial_duration = this.moov.mvhd.duration;
	this.moov.mvhd.duration = 0;
	for (i = 0; i < this.moov.traks.length; i++) {
		trak = this.moov.traks[i];
		trak.tkhd.duration = 0;
		trak.mdia.mdhd.duration = 0;
		stco = trak.mdia.minf.stbl.stco || trak.mdia.minf.stbl.co64;
		stco.chunk_offsets = [];
		stsc = trak.mdia.minf.stbl.stsc;
		stsc.first_chunk = [];
		stsc.samples_per_chunk = [];
		stsc.sample_description_index = [];
		stsz = trak.mdia.minf.stbl.stsz;
		stsz.sample_sizes = [];
		stts = trak.mdia.minf.stbl.stts;
		stts.sample_counts = [];
		stts.sample_deltas = [];
		ctts = trak.mdia.minf.stbl.ctts;
		if (ctts) {
			ctts.sample_counts = [];
			ctts.sample_offsets = [];
		}
		stss = trak.mdia.minf.stbl.stss;
		if (stss) {
			stss.sample_numbers = new Uint32Array(0);
		}
		sdtp = trak.mdia.minf.stbl.sdtp;
		var k = trak.mdia.minf.stbl.boxes.indexOf(sdtp);
		if (k != -1) trak.mdia.minf.stbl.boxes[k] = null;
	}
}

/* Build initial sample list from  sample tables */
ISOFile.prototype.buildSampleLists = function() {	
	var i, j, k;
	var trak, stco, stsc, stsz, stts, ctts, stss, stsd, subs;
	var chunk_run_index, chunk_index, last_chunk_in_run, offset_in_chunk, last_sample_in_chunk;
	var last_sample_in_stts_run, stts_run_index, last_sample_in_ctts_run, ctts_run_index, last_stss_index, last_subs_index;
	// TODO: this is a hack!
	this.originalMvex = this.moov.mvex;
	for (i = 0; i < this.moov.traks.length; i++) {
		trak = this.moov.traks[i];
		trak.samples = [];
		stco = trak.mdia.minf.stbl.stco || trak.mdia.minf.stbl.co64;
		stsc = trak.mdia.minf.stbl.stsc;
		stsz = trak.mdia.minf.stbl.stsz;
		stts = trak.mdia.minf.stbl.stts;
		ctts = trak.mdia.minf.stbl.ctts;
		stss = trak.mdia.minf.stbl.stss;
		stsd = trak.mdia.minf.stbl.stsd;
		subs = trak.mdia.minf.stbl.subs;
		
		last_sample_in_stts_run = -1;
		stts_run_index = -1;
		last_sample_in_ctts_run = -1;
		ctts_run_index = -1;
		last_stss_index = 0;
		subs_entry_index = 0;
		last_subs_sample_index = 0;
		/* we build the samples one by one and compute their properties */
		for (j = 0; j < stsz.sample_sizes.length; j++) {
			var sample = {};
			sample.number = j;
			sample.track_id = trak.tkhd.track_id;
			sample.timescale = trak.mdia.mdhd.timescale;
			trak.samples[j] = sample;
			/* size can be known directly */
			sample.size = stsz.sample_sizes[j];

			/* computing chunk-based properties (offset, sample description index)*/
			if (j === 0) {				
				chunk_index = 1; /* the first sample is in the first chunk (chunk indexes are 1-based) */
				chunk_run_index = 0; /* the first chunk is the first entry in the first_chunk table */
				sample.chunk_index = chunk_index;
				sample.chunk_run_index = chunk_run_index;
				last_sample_in_chunk = stsc.samples_per_chunk[chunk_run_index];
				offset_in_chunk = 0;

				/* Is there another entry in the first_chunk table ? */
				if (chunk_run_index + 1 < stsc.first_chunk.length) {
					/* The last chunk in the run is the chunk before the next first chunk */
					last_chunk_in_run = stsc.first_chunk[chunk_run_index+1]-1; 	
				} else {
					/* There is only one entry in the table, it is valid for all future chunks*/
					last_chunk_in_run = Infinity;
				}
			} else {
				if (j < last_sample_in_chunk) {
					/* the sample is still in the current chunk */
					sample.chunk_index = chunk_index;
					sample.chunk_run_index = chunk_run_index;
				} else {
					/* the sample is in the next chunk */
					chunk_index++;
					sample.chunk_index = chunk_index;
					/* reset the accumulated offset in the chunk */
					offset_in_chunk = 0;
					if (chunk_index <= last_chunk_in_run) {
						/* stay in the same entry of the first_chunk table */
						/* chunk_run_index unmodified */
					} else {
						chunk_run_index++;
						/* Is there another entry in the first_chunk table ? */
						if (chunk_run_index + 1 < stsc.first_chunk.length) {
							/* The last chunk in the run is the chunk before the next first chunk */
							last_chunk_in_run = stsc.first_chunk[chunk_run_index+1]-1; 	
						} else {
							/* There is only one entry in the table, it is valid for all future chunks*/
							last_chunk_in_run = Infinity;
						}
						
					}
					sample.chunk_run_index = chunk_run_index;
					last_sample_in_chunk += stsc.samples_per_chunk[chunk_run_index];
				}
			}

			sample.description = stsd.entries[stsc.sample_description_index[sample.chunk_run_index]-1];
			sample.offset = stco.chunk_offsets[sample.chunk_index-1] + offset_in_chunk; /* chunk indexes are 1-based */
			offset_in_chunk += sample.size;

			/* setting dts, cts, duration and rap flags */
			if (j > last_sample_in_stts_run) {
				stts_run_index++;
				if (last_sample_in_stts_run < 0) {
					last_sample_in_stts_run = 0;
				}
				last_sample_in_stts_run += stts.sample_counts[stts_run_index];				
			}
			if (j > 0) {
				trak.samples[j-1].duration = stts.sample_deltas[stts_run_index];
				sample.dts = trak.samples[j-1].dts + trak.samples[j-1].duration;
			} else {
				sample.dts = 0;
			}
			if (ctts) {
				if (j > last_sample_in_ctts_run) {
					ctts_run_index++;
					last_sample_in_ctts_run += ctts.sample_counts[ctts_run_index];				
				}
				sample.cts = trak.samples[j].dts + ctts.sample_offsets[ctts_run_index];
			} else {
				sample.cts = sample.dts;
			}
			if (stss) {
				if (j == stss.sample_numbers[last_stss_index] - 1) { // sample numbers are 1-based
					sample.is_rap = true;
					last_stss_index++;
				} else {
					sample.is_rap = false;				
				}
			} else {
				sample.is_rap = true;
			}
			if (subs) {
				if (subs.samples[subs_entry_index].sample_delta + last_subs_sample_index == j) {
					sample.subsamples = subs.samples[subs_entry_index].subsamples;
					last_subs_sample_index += subs.samples[subs_entry_index].sample_delta;
				}
			}
		}
		if (j>0) trak.samples[j-1].duration = trak.mdia.mdhd.duration - trak.samples[j-1].dts;
	}
}

/* Update sample list when new 'moof' boxes are received */
ISOFile.prototype.updateSampleLists = function() {	
	var i, j, k;
	var default_sample_description_index, default_sample_duration, default_sample_size, default_sample_flags;
	var last_run_position;
	var box, moof, traf, trak, trex;
	var sample;
	
	/* if the input file is fragmented and fetched in multiple downloads, we need to update the list of samples */
	while (this.lastMoofIndex < this.moofs.length) {
		box = this.moofs[this.lastMoofIndex];
		this.lastMoofIndex++;
		if (box.type == "moof") {
			moof = box;
			for (i = 0; i < moof.trafs.length; i++) {
				traf = moof.trafs[i];
				trak = this.getTrackById(traf.tfhd.track_id);
				trex = this.getTrexById(traf.tfhd.track_id);
				if (traf.tfhd.flags & BoxParser.TFHD_FLAG_SAMPLE_DESC) {
					default_sample_description_index = traf.tfhd.default_sample_description_index;
				} else {
					default_sample_description_index = trex.default_sample_description_index;
				}
				if (traf.tfhd.flags & BoxParser.TFHD_FLAG_SAMPLE_DUR) {
					default_sample_duration = traf.tfhd.default_sample_duration;
				} else {
					default_sample_duration = trex.default_sample_duration;
				}
				if (traf.tfhd.flags & BoxParser.TFHD_FLAG_SAMPLE_SIZE) {
					default_sample_size = traf.tfhd.default_sample_size;
				} else {
					default_sample_size = trex.default_sample_size;
				}
				if (traf.tfhd.flags & BoxParser.TFHD_FLAG_SAMPLE_FLAGS) {
					default_sample_flags = traf.tfhd.default_sample_flags;
				} else {
					default_sample_flags = trex.default_sample_flags;
				}
				for (j = 0; j < traf.truns.length; j++) {
					var trun = traf.truns[j];
					for (k = 0; k < trun.sample_count; k++) {
						sample = {};
						traf.first_sample_index = trak.samples.length;
						trak.samples.push(sample);
						sample.track_id = trak.tkhd.track_id;
						sample.timescale = trak.mdia.mdhd.timescale;
						sample.description = trak.mdia.minf.stbl.stsd.entries[default_sample_description_index-1];
						sample.size = default_sample_size;
						if (trun.flags & BoxParser.TRUN_FLAGS_SIZE) {
							sample.size = trun.sample_size[k];
						}
						sample.duration = default_sample_duration;
						if (trun.flags & BoxParser.TRUN_FLAGS_DURATION) {
							sample.duration = trun.sample_duration[k];
						}
						if (trak.first_traf_merged || k > 0) {
							sample.dts = trak.samples[trak.samples.length-2].dts+trak.samples[trak.samples.length-2].duration;
						} else {
							if (traf.tfdt) {
								sample.dts = traf.tfdt.baseMediaDecodeTime;
							} else {
								sample.dts = 0;
							}
							trak.first_traf_merged = true;
						}
						sample.cts = sample.dts;
						if (trun.flags & BoxParser.TRUN_FLAGS_CTS_OFFSET) {
							sample.cts = sample.dts + trun.sample_composition_time_offset[k];
						}
						sample_flags = default_sample_flags;
						if (trun.flags & BoxParser.TRUN_FLAGS_FLAGS) {
							sample_flags = trun.sample_flags[k];
						} else if (k === 0 && (trun.flags & BoxParser.TRUN_FLAGS_FIRST_FLAG)) {
							sample_flags = trun.first_sample_flags;
						}
						sample.is_rap = ((sample_flags >> 16 & 0x1) ? false : true);
						var bdop = (traf.tfhd.flags & BoxParser.TFHD_FLAG_BASE_DATA_OFFSET) ? true : false;
						var dbim = (traf.tfhd.flags & BoxParser.TFHD_FLAG_DEFAULT_BASE_IS_MOOF) ? true : false;
						var dop = (trun.flags & BoxParser.TRUN_FLAGS_DATA_OFFSET) ? true : false;
						var bdo = 0;
						if (!bdop) {
							if (!dbim) {
								if (j === 0) { // the first track in the movie fragment
									bdo = moof.fileStart; // the position of the first byte of the enclosing Movie Fragment Box
								} else {
									bdo = last_run_position; // end of the data defined by the preceding *track* (irrespective of the track id) fragment in the moof
								}
							} else {
								bdo = moof.fileStart;
							}
						} else {
							bdo = traf.tfhd.base_data_offset;
						}
						if (j === 0 && k === 0) {
							if (dop) {
								sample.offset = bdo + trun.data_offset; // If the data-offset is present, it is relative to the base-data-offset established in the track fragment header
							} else {
								sample.offset = bdo; // the data for this run starts the base-data-offset defined by the track fragment header
							}
						} else {
							sample.offset = last_run_position; // this run starts immediately after the data of the previous run
						}
						last_run_position = sample.offset + sample.size;
					}
				}
				if (traf.subs) {
					var sample_index = traf.first_sample_index;
					for (j = 0; j < traf.subs.samples.length; j++) {
						sample_index += traf.subs.samples[j].sample_delta;
						sample = trak.samples[sample_index-1];
						sample.subsamples = traf.subs.samples[j].subsamples;
					}					
				}
			}
		}
	}	
}

/* Builds the MIME Type 'codecs' sub-parameters for the whole file */
ISOFile.prototype.getCodecs = function() {	
	var i;
	var codecs = "";
	for (i = 0; i < this.moov.traks.length; i++) {
		var trak = this.moov.traks[i];
		if (i>0) {
			codecs+=","; 
		}
		codecs += trak.mdia.minf.stbl.stsd.entries[0].getCodec();		
	}
	return codecs;
}

/* Helper function */
ISOFile.prototype.getTrexById = function(id) {	
	var i;
	// TODO: this is a hacky fix for fragmented files not working
	if (!this.originalMvex) return null;
	for (i = 0; i < this.originalMvex.trexs.length; i++) {
		var trex = this.originalMvex.trexs[i];
		if (trex.track_id == id) return trex;
	}
	return null;
}

/* Helper function */
ISOFile.prototype.getTrackById = function(id) {
	for (var j = 0; j < this.moov.traks.length; j++) {
		var trak = this.moov.traks[j];
		if (trak.tkhd.track_id == id) return trak;
	}
	return null;
}

/* Try to get sample data for a given sample:
   returns null if not found
   returns the same sample if already requested
 */
ISOFile.prototype.getSample = function(trak, sampleNum) {	
	var buffer;
	var i;
	var sample = trak.samples[sampleNum];
	
	if (!this.moov) {
		return null;
	}

	if (!sample.data) {
		/* Not yet fetched */
		sample.data = new Uint8Array(sample.size);
		sample.alreadyRead = 0;
		this.samplesDataSize += sample.size;
		Log.d("ISOFile", "Allocating sample #"+sampleNum+" on track #"+trak.tkhd.track_id+" of size "+sample.size+" (total: "+this.samplesDataSize+")");
	} else if (sample.alreadyRead == sample.size) {
		/* Already fetched entirely */
		return sample;
	}

	/* The sample has only been partially fetched, we need to check in all mdat boxes (e.g. if the input file is fragmented) 
	   and in all mdat buffers (if the input file was not fetched in a single download) */
	for (i = 0; i < this.stream.nextBuffers.length; i++) {
		buffer = this.stream.nextBuffers[i];

		if (sample.offset + sample.alreadyRead >= buffer.fileStart &&
		    sample.offset + sample.alreadyRead <  buffer.fileStart + buffer.byteLength) {
			/* The sample starts in this buffer */
			
			var lengthAfterStart = buffer.byteLength - (sample.offset + sample.alreadyRead - buffer.fileStart);
			if (sample.size - sample.alreadyRead <= lengthAfterStart) {
				/* the (rest of the) sample is entirely contained in this buffer */

				Log.d("ISOFile","Getting sample #"+sampleNum+" data (alreadyRead: "+sample.alreadyRead+" offset: "+
					(sample.offset+sample.alreadyRead - buffer.fileStart)+" size: "+(sample.size - sample.alreadyRead)+")");

				DataStream.memcpy(sample.data.buffer, sample.alreadyRead, 
				                  buffer, sample.offset+sample.alreadyRead - buffer.fileStart, sample.size - sample.alreadyRead);
				sample.alreadyRead = sample.size;

				/* update the number of bytes used in this buffer and check if it needs to be removed */
				buffer.usedBytes += sample.size - sample.alreadyRead;
				if (buffer.usedBytes === buffer.byteLength) {
					this.stream.nextBuffers.splice(i, 1);
					i--;
					/* TODO: check if the DataStream buffer needs to be updated */
				}

				return sample;
			} else {
				/* the sample does not end in this buffer */				
				
				Log.d("ISOFile","Getting sample data (alreadyRead: "+sample.alreadyRead+" offset: "+
					(sample.offset+sample.alreadyRead - buffer.fileStart)+" size: "+lengthAfterStart+")");
				
				DataStream.memcpy(sample.data.buffer, sample.alreadyRead, 
				                  buffer, sample.offset+sample.alreadyRead - buffer.fileStart, lengthAfterStart);
				sample.alreadyRead += lengthAfterStart;

				/* update the number of bytes used in this buffer and check if it needs to be removed */
				buffer.usedBytes += lengthAfterStart;
				if (buffer.usedBytes === buffer.byteLength) {
					this.stream.nextBuffers.splice(i, 1);
					i--;
					/* TODO: check if the DataStream buffer needs to be updated */
				}
			}
		}
	}
	return null;
}

/* Release the memory used to store the data of the sample */
ISOFile.prototype.releaseSample = function(trak, sampleNum) {	
	var sample = trak.samples[sampleNum];
	sample.data = null;
	this.samplesDataSize -= sample.size;
	return sample.size;
}

},{"./DataStream":165,"./box":166,"./log":169}],169:[function(require,module,exports){
/* 
 * Copyright (c) 2012-2013. Telecom ParisTech/TSI/MM/GPAC Cyril Concolato
 * License: BSD-3-Clause (see LICENSE file)
 */
var Log = (function (){
		var start = new Date();
		var LOG_LEVEL_ERROR 	= 4;
		var LOG_LEVEL_WARNING 	= 3;
		var LOG_LEVEL_INFO 		= 2;
		var LOG_LEVEL_DEBUG		= 1;
		var log_level = LOG_LEVEL_ERROR;
		var logObject = {
			setLogLevel : function(level) {
				if (level == this.d) log_level = LOG_LEVEL_DEBUG;
				else if (level == this.i) log_level = LOG_LEVEL_INFO;
				else if (level == this.w) log_level = LOG_LEVEL_WARNING;
				else if (level == this.e) log_level = LOG_LEVEL_ERROR;
				else log_level = LOG_LEVEL_ERROR;
			},
			d : function(module, msg) {
				if (LOG_LEVEL_DEBUG >= log_level) {
					console.debug("["+Log.getDurationString(new Date()-start,1000)+"]","["+module+"]",msg);
				}
			},
			i : function(module, msg) {
				if (LOG_LEVEL_INFO >= log_level) {
					console.info("["+Log.getDurationString(new Date()-start,1000)+"]","["+module+"]",msg);
				}
			},
			w : function(module, msg) {
				if (LOG_LEVEL_WARNING >= log_level) {
					console.warn("["+Log.getDurationString(new Date()-start,1000)+"]","["+module+"]",msg);
				}
			},
			e : function(module, msg) {
				if (LOG_LEVEL_ERROR >= log_level) {
					console.error("["+Log.getDurationString(new Date()-start,1000)+"]","["+module+"]",msg);
				}
			}
		};
		return logObject;
	})();
module.exports = Log;
	
/* Helper function to print a duration value in the form H:MM:SS.MS */
Log.getDurationString = function(duration, _timescale) {

	/* Helper function to print a number on a fixed number of digits */
	function pad(number, length) {
		var str = '' + number;
		var a = str.split('.');		
		while (a[0].length < length) {
			a[0] = '0' + a[0];
		}
		return a.join('.');
	}

	var timescale = _timescale || 1;
	var duration_sec = duration/timescale;
	var hours = Math.floor(duration_sec/3600);
	duration_sec -= hours * 3600;
	var minutes = Math.floor(duration_sec/60);
	duration_sec -= minutes * 60;		
	var msec = duration_sec*1000;
	duration_sec = Math.floor(duration_sec);
	msec -= duration_sec*1000;
	msec = Math.floor(msec);
	return ""+hours+":"+pad(minutes,2)+":"+pad(duration_sec,2)+"."+pad(msec,3);
}
	
/* Helper function to stringify HTML5 TimeRanges objects */	
Log.printRanges = function(ranges) {
	var length = ranges.length;
	if (length > 0) {
		var str = "";
		for (var i = 0; i < length; i++) {
		  if (i > 0) str += ",";
		  str += "["+Log.getDurationString(ranges.start(i))+ ","+Log.getDurationString(ranges.end(i))+"]";
		}
		return str;
	} else {
		return "(empty)";
	}
}


},{}],170:[function(require,module,exports){
/* 
 * Copyright (c) 2012-2013. Telecom ParisTech/TSI/MM/GPAC Cyril Concolato
 * License: BSD-3-Clause (see LICENSE file)
 */
var BoxParser = require('./box');
var DataStream = require('./DataStream');
var ISOFile = require('./isofile');
var Log = require('./log');
var MP4Box = function () {
	/* DataStream object used to parse the boxes */
	this.inputStream = null;
	/* List of ArrayBuffers, with a fileStart property, sorted in fileStart order and non overlapping */
	this.nextBuffers = [];	
	/* ISOFile object containing the parsed boxes */
	this.inputIsoFile = null;
	/* Callback called when the moov parsing starts */
	this.onMoovStart = null;
	/* Boolean keeping track of the call to onMoovStart, to avoid double calls */
	this.moovStartSent = false;
	/* Callback called when the moov is entirely parsed */
	this.onReady = null;
	/* Boolean keeping track of the call to onReady, to avoid double calls */
	this.readySent = false;	
	/* Callback to call when segments are ready */
	this.onSegment = null;
	/* Callback to call when samples are ready */
	this.onSamples = null;
	/* Callback to call when there is an error in the parsing or processing of samples */	
	this.onError = null;
	/* Boolean indicating if the moov box run-length encoded tables of sample information have been processed */
	this.sampleListBuilt = false;
	/* Array of Track objects for which fragmentation of samples is requested */
	this.fragmentedTracks = [];
	/* Array of Track objects for which extraction of samples is requested */
	this.extractedTracks = [];
	/* Boolean indicating that fragmented has started */
	this.isFragmentationStarted = false;
	/* Number of the next 'moof' to generate when fragmenting */
	this.nextMoofNumber = 0;
}
module.exports = MP4Box;

MP4Box.prototype.setSegmentOptions = function(id, user, options) {
	var trak = this.inputIsoFile.getTrackById(id);
	if (trak) {
		var fragTrack = {};
		this.fragmentedTracks.push(fragTrack);
		fragTrack.id = id;
		fragTrack.user = user;
		fragTrack.trak = trak;
		trak.nextSample = 0;
		fragTrack.segmentStream = null;
		fragTrack.nb_samples = 1000;
		fragTrack.rapAlignement = true;
		if (options) {
			if (options.nbSamples) fragTrack.nb_samples = options.nbSamples;
			if (options.rapAlignement) fragTrack.rapAlignement = options.rapAlignement;
		}
	}
}

MP4Box.prototype.unsetSegmentOptions = function(id) {
	var index = -1;
	for (var i = 0; i < this.fragmentedTracks.length; i++) {
		var fragTrack = this.fragmentedTracks[i];
		if (fragTrack.id == id) {
			index = i;
		}
	}
	if (index > -1) {
		this.fragmentedTracks.splice(index, 1);
	}
}

MP4Box.prototype.setExtractionOptions = function(id, user, options) {
	var trak = this.inputIsoFile.getTrackById(id);
	if (trak) {
		var extractTrack = {};
		this.extractedTracks.push(extractTrack);
		extractTrack.id = id;
		extractTrack.user = user;
		extractTrack.trak = trak;
		trak.nextSample = 0;
		extractTrack.nb_samples = 1000;
		extractTrack.samples = [];
		if (options) {
			if (options.nbSamples) extractTrack.nb_samples = options.nbSamples;
		}
	}
}

MP4Box.prototype.unsetExtractionOptions = function(id) {
	var index = -1;
	for (var i = 0; i < this.extractedTracks.length; i++) {
		var extractTrack = this.extractedTracks[i];
		if (extractTrack.id == id) {
			index = i;
		}
	}
	if (index > -1) {
		this.extractedTracks.splice(index, 1);
	}
}

// key:
// depended_on: 1
// has_redundancy: 2
// depends_on: 2
// is_leading: 2
// 0a600000

// regular:
// depended_on: 1
// has_redundancy: 2
// depends_on: 1
// is_leading: 2
// 09610000

MP4Box.prototype.createSingleSampleMoof = function(sample) {
	var moof = new BoxParser.moofBox();
	var mfhd = new BoxParser.mfhdBox();
	mfhd.sequence_number = this.nextMoofNumber;
	this.nextMoofNumber++;
	moof.boxes.push(mfhd);
	var traf = new BoxParser.trafBox();
	moof.boxes.push(traf);
	var tfhd = new BoxParser.tfhdBox();
	traf.boxes.push(tfhd);
	tfhd.track_id = sample.track_id;
	tfhd.flags = BoxParser.TFHD_FLAG_DEFAULT_BASE_IS_MOOF;
	var tfdt = new BoxParser.tfdtBox();
	traf.boxes.push(tfdt);
	tfdt.baseMediaDecodeTime = sample.dts;
	var trun = new BoxParser.trunBox();
	traf.boxes.push(trun);
	moof.trun = trun;
	trun.flags = BoxParser.TRUN_FLAGS_DATA_OFFSET | BoxParser.TRUN_FLAGS_DURATION | 
				 BoxParser.TRUN_FLAGS_SIZE | BoxParser.TRUN_FLAGS_FLAGS | 
				 BoxParser.TRUN_FLAGS_CTS_OFFSET;
	trun.data_offset = 0;
	trun.first_sample_flags = 0;
	trun.sample_count = 1;
	trun.sample_duration = [];
	trun.sample_duration[0] = sample.duration;
	trun.sample_size = [];
	trun.sample_size[0] = sample.size;
	trun.sample_flags = [];
	trun.sample_flags[0] = 0; //= sample.is_rap ? 0x0a600000 : 0x09610000; //sample.is_rap ? 0 : (1<<16);
	trun.sample_composition_time_offset = [];
	trun.sample_composition_time_offset[0] = sample.cts - sample.dts;
	return moof;
}

MP4Box.prototype.createFragment = function(input, track_id, sampleNumber, stream_) {
	var trak = this.inputIsoFile.getTrackById(track_id);
	var sample = this.inputIsoFile.getSample(trak, sampleNumber);
	if (sample == null) {
		if (this.nextSeekPosition) {
			this.nextSeekPosition = Math.min(trak.samples[sampleNumber].offset,this.nextSeekPosition);
		} else {
			this.nextSeekPosition = trak.samples[sampleNumber].offset;
		}
		return null;
	}
	
	var stream = stream_ || new DataStream();
	stream.endianness = DataStream.BIG_ENDIAN;

	var moof = this.createSingleSampleMoof(sample);
	moof.write(stream);

	/* adjusting the data_offset now that the moof size is known*/
	moof.trun.data_offset = moof.size+8; //8 is mdat header
	Log.d("BoxWriter", "Adjusting data_offset with new value "+moof.trun.data_offset);
	stream.adjustUint32(moof.trun.data_offset_position, moof.trun.data_offset);
		
	var mdat = new BoxParser.mdatBox();
	mdat.data = sample.data;
	mdat.write(stream);
	return stream;
}

/* helper functions to enable calling "open" with additional buffers */
ArrayBuffer.concat = function(buffer1, buffer2) {
  Log.d("ArrayBuffer", "Trying to create a new buffer of size: "+(buffer1.byteLength + buffer2.byteLength));
  var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  tmp.set(new Uint8Array(buffer1), 0);
  tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
  return tmp.buffer;
};

/* Reduces the size of a given buffer */
MP4Box.prototype.reduceBuffer = function(buffer, offset, newLength) {
	var smallB;
	smallB = new Uint8Array(newLength);
	smallB.set(new Uint8Array(buffer, offset, newLength));
	smallB.buffer.fileStart = buffer.fileStart+offset;
	smallB.buffer.usedBytes = 0;
	return smallB.buffer;	
}

/* insert the new buffer in the sorted list of buffers (nextBuffers), 
   making sure, it is not overlapping with existing ones (possibly reducing its size).
   if the new buffer overrides/replaces the 0-th buffer (for instance because it is bigger), 
   updates the DataStream buffer for parsing */
MP4Box.prototype.insertBuffer = function(ab) {	
	var to_add = true;
	/* TODO: improve insertion if many buffers */
	for (var i = 0; i < this.nextBuffers.length; i++) {
		var b = this.nextBuffers[i];
		if (ab.fileStart <= b.fileStart) {
			/* the insertion position is found */
			if (ab.fileStart === b.fileStart) {
				/* The new buffer overlaps with an existing buffer */
				if (ab.byteLength >  b.byteLength) {
					/* the new buffer is bigger than the existing one
					   remove the existing buffer and try again to insert 
					   the new buffer to check overlap with the next ones */
					this.nextBuffers.splice(i, 1);
					i--; 
					continue;
				} else {
					/* the new buffer is smaller than the existing one, just drop it */
					Log.w("MP4Box", "Buffer (fileStart: "+ab.fileStart+" - Length: "+ab.byteLength+") already appended, ignoring");
				}
			} else {
				/* The beginning of the new buffer is not overlapping with an existing buffer
				   let's check the end of it */
				if (ab.fileStart + ab.byteLength <= b.fileStart) {
					/* no overlap, we can add it as is */
				} else {
					/* There is some overlap, cut the new buffer short, and add it*/
					ab = this.reduceBuffer(ab, 0, b.fileStart - ab.fileStart);
				}
				Log.d("MP4Box", "Appending new buffer (fileStart: "+ab.fileStart+" - Length: "+ab.byteLength+")");
				this.nextBuffers.splice(i, 0, ab);
				/* if this new buffer is inserted in the first place in the list of the buffer, 
				   and the DataStream is initialized, make it the buffer used for parsing */
				if (i === 0 && this.inputStream !== null) {
					this.inputStream.buffer = ab;
				}
			}
			to_add = false;
			break;
		} else if (ab.fileStart < b.fileStart + b.byteLength) {
			/* the new buffer overlaps its beginning with the end of the current buffer */
			var offset = b.fileStart + b.byteLength - ab.fileStart;
			var newLength = ab.byteLength - offset;
			if (newLength > 0) {
				/* the new buffer is bigger than the current overlap, drop the overlapping part and try again inserting the remaining buffer */
				ab = this.reduceBuffer(ab, offset, newLength);
			} else {
				/* the content of the new buffer is entirely contained in the existing buffer, drop it entirely */
				to_add = false;
				break;
			}
		}
	}
	/* if the buffer has not been added, we can add it at the end */
	if (to_add) {
		Log.d("MP4Box", "Appending new buffer (fileStart: "+ab.fileStart+" - Length: "+ab.byteLength+")");
		this.nextBuffers.push(ab);
		/* if this new buffer is inserted in the first place in the list of the buffer, 
		   and the DataStream is initialized, make it the buffer used for parsing */
		if (i === 0 && this.inputStream !== null) {
			this.inputStream.buffer = ab;
		}
	}
}

MP4Box.prototype.processSamples = function() {
	var i;
	var trak;
	/* For each track marked for fragmentation, 
	   check if the next sample is there (i.e. if the sample information is known (i.e. moof has arrived) and if it has been downloaded) 
	   and create a fragment with it */
	if (this.isFragmentationStarted && this.onSegment !== null) {
		for (i = 0; i < this.fragmentedTracks.length; i++) {
			var fragTrak = this.fragmentedTracks[i];
			trak = fragTrak.trak;
			while (trak.nextSample < trak.samples.length) {				
				/* The sample information is there (either because the file is not fragmented and this is not the last sample, 
				or because the file is fragmented and the moof for that sample has been received */
				Log.d("MP4Box", "Creating media fragment on track #"+fragTrak.id +" for sample "+trak.nextSample); 
				var result = this.createFragment(this.inputIsoFile, fragTrak.id, trak.nextSample, fragTrak.segmentStream);
				if (result) {
					fragTrak.segmentStream = result;
					trak.nextSample++;
				} else {
					/* The fragment could not be created because the media data is not there (not downloaded), wait for it */
					break;
				}
				/* A fragment is created by sample, but the segment is the accumulation in the buffer of these fragments.
				   It is flushed only as requested by the application (nb_samples) to avoid too many callbacks */
				if (trak.nextSample % fragTrak.nb_samples === 0 || trak.nextSample >= trak.samples.length) {
					Log.i("MP4Box", "Sending fragmented data on track #"+fragTrak.id+" for samples ["+(trak.nextSample-fragTrak.nb_samples)+","+(trak.nextSample-1)+"]"); 
					if (this.onSegment) {
						this.onSegment(fragTrak.id, fragTrak.user, fragTrak.segmentStream.buffer, trak.nextSample);
					}
					/* force the creation of a new buffer */
					fragTrak.segmentStream = null;
					if (fragTrak !== this.fragmentedTracks[i]) {
						/* make sure we can stop fragmentation if needed */
						break;
					}
				}
			}
		}
	}

	if (this.onSamples !== null) {
		/* For each track marked for data export, 
		   check if the next sample is there (i.e. has been downloaded) and send it */
		for (i = 0; i < this.extractedTracks.length; i++) {
			var extractTrak = this.extractedTracks[i];
			trak = extractTrak.trak;
			while (trak.nextSample < trak.samples.length) {				
				Log.d("MP4Box", "Exporting on track #"+extractTrak.id +" sample #"+trak.nextSample);
				var sample = this.inputIsoFile.getSample(trak, trak.nextSample);
				if (sample) {
					trak.nextSample++;
					extractTrak.samples.push(sample);
				} else {
					return;
				}
				if (trak.nextSample % extractTrak.nb_samples === 0 || trak.nextSample >= trak.samples.length) {
					Log.d("MP4Box", "Sending samples on track #"+extractTrak.id+" for sample "+trak.nextSample); 
					if (this.onSamples) {
						this.onSamples(extractTrak.id, extractTrak.user, extractTrak.samples);
					}
					extractTrak.samples = [];
					if (extractTrak !== this.extractedTracks[i]) {
						/* check if the extraction needs to be stopped */
						break;
					}
				}
			}
		}
	}
}

/* Processes a new ArrayBuffer (with a fileStart property)
   Returns the next expected file position, or undefined if not ready to parse */
MP4Box.prototype.appendBuffer = function(ab) {
	var nextFileStart;
	var firstBuffer;
	if (ab === null || ab === undefined) {
		throw("Buffer must be defined and non empty");
	}	
	if (ab.fileStart === undefined) {
		throw("Buffer must have a fileStart property");
	}	
	if (ab.byteLength === 0) {
		Log.w("MP4Box", "Ignoring empty buffer (fileStart: "+ab.fileStart+")");
		return;
	}
	/* mark the bytes in the buffer as not being used yet */
	ab.usedBytes = 0;
	this.insertBuffer(ab);

	/* We create the DataStream object only when we have the first bytes of the file */
	if (!this.inputStream) { 
		if (this.nextBuffers.length > 0) {
			firstBuffer = this.nextBuffers[0];
			if (firstBuffer.fileStart === 0) {
				this.inputStream = new DataStream(firstBuffer, 0, DataStream.BIG_ENDIAN);	
				this.inputStream.nextBuffers = this.nextBuffers;
				this.inputStream.bufferIndex = 0;
			} else {
				Log.w("MP4Box", "The first buffer should have a fileStart of 0");
				return;
			}
		} else {
			Log.w("MP4Box", "No buffer to start parsing from");
			return;
		}		
	} 

	/* Initialize the ISOFile object if not yet created */
	if (!this.inputIsoFile) {
		this.inputIsoFile = new ISOFile(this.inputStream);
	}

	/* Parse whatever is in the existing buffers */
	this.inputIsoFile.parse();

	/* Check if the moovStart callback needs to be called */
	if (this.inputIsoFile.moovStartFound && !this.moovStartSent) {
		this.moovStartSent = true;
		if (this.onMoovStart) this.onMoovStart();
	}

	if (this.inputIsoFile.moov) {
		/* A moov box has been entirely parsed */
		
		/* if this is the first call after the moov is found we initialize the list of samples (may be empty in fragmented files) */
		if (!this.sampleListBuilt) {
			this.inputIsoFile.buildSampleLists();
			this.sampleListBuilt = true;
		} 

		/* We update the sample information if there are any new moof boxes */
		this.inputIsoFile.updateSampleLists();
		
		/* If the application needs to be informed that the 'moov' has been found, 
		   we create the information object and callback the application */
		if (this.onReady && !this.readySent) {
			var info = this.getInfo();
			this.readySent = true;
			this.onReady(info);
		}

		/* See if any sample extraction or segment creation needs to be done with the available samples */
		this.processSamples();

		/* Inform about the best range to fetch next */
		if (this.nextSeekPosition) {
			nextFileStart = this.nextSeekPosition;
			this.nextSeekPosition = undefined;
		} else {
			nextFileStart = this.inputIsoFile.nextParsePosition;
		}		
		var index = this.inputIsoFile.findPosition(true, nextFileStart);
		if (index !== -1) {
			nextFileStart = this.inputIsoFile.findEndContiguousBuf(index);
		}
		Log.i("MP4Box", "Next buffer to fetch should have a fileStart position of "+nextFileStart);
		return nextFileStart;
	} else {
		if (this.inputIsoFile !== null) {
			/* moov has not been parsed but the first buffer was received, 
			   the next fetch should probably be the next box start */
			return this.inputIsoFile.nextParsePosition;
		} else {
			/* No valid buffer has been parsed yet, we cannot know what to parse next */
			return 0;
		}
	}	
}

MP4Box.prototype.getInfo = function() {
	var movie = {};
	var trak;
	var track;
	var sample_desc;
	var _1904 = (new Date(4, 0, 1, 0, 0, 0, 0).getTime());

	movie.duration = this.inputIsoFile.moov.mvhd.duration;
	movie.timescale = this.inputIsoFile.moov.mvhd.timescale;
	movie.isFragmented = (this.inputIsoFile.moov.mvex != null);
	if (movie.isFragmented && this.inputIsoFile.moov.mvex.mehd) {
		movie.fragment_duration = this.inputIsoFile.moov.mvex.mehd.fragment_duration;
	} else {
		movie.fragment_duration = 0;
	}
	movie.isProgressive = this.inputIsoFile.isProgressive;
	movie.hasIOD = (this.inputIsoFile.moov.iods != null);
	movie.brands = []; 
	movie.brands.push(this.inputIsoFile.ftyp.major_brand);
	movie.brands = movie.brands.concat(this.inputIsoFile.ftyp.compatible_brands);	
	movie.created = new Date(_1904+this.inputIsoFile.moov.mvhd.creation_time*1000);
	movie.modified = new Date(_1904+this.inputIsoFile.moov.mvhd.modification_time*1000);
	movie.tracks = [];
	movie.audioTracks = [];
	movie.videoTracks = [];
	movie.subtitleTracks = [];
	movie.metadataTracks = [];
	movie.hintTracks = [];
	movie.otherTracks = [];
	for (i = 0; i < this.inputIsoFile.moov.traks.length; i++) {
		trak = this.inputIsoFile.moov.traks[i];
		sample_desc = trak.mdia.minf.stbl.stsd.entries[0];
		track = {};
		movie.tracks.push(track);
		track.id = trak.tkhd.track_id;
		track.references = [];
		if (trak.tref) {
			for (j = 0; j < trak.tref.boxes.length; j++) {
				ref = {};
				track.references.push(ref);
				ref.type = trak.tref.boxes[j].type;
				ref.track_ids = trak.tref.boxes[j].track_ids;
			}
		}
		track.created = new Date(_1904+trak.tkhd.creation_time*1000);
		track.modified = new Date(_1904+trak.tkhd.modification_time*1000);
		track.movie_duration = trak.tkhd.duration;
		track.layer = trak.tkhd.layer;
		track.alternate_group = trak.tkhd.alternate_group;
		track.volume = trak.tkhd.volume;
		track.matrix = trak.tkhd.matrix;
		track.track_width = trak.tkhd.width/(1<<16);
		track.track_height = trak.tkhd.height/(1<<16);
		track.timescale = trak.mdia.mdhd.timescale;
		track.duration = trak.mdia.mdhd.duration;
		track.codec = sample_desc.getCodec();	
		track.language = trak.mdia.mdhd.languageString;
		track.nb_samples = trak.samples.length;
		track.size = 0;
		for (j = 0; j < track.nb_samples; j++) {
			track.size += trak.samples[j].size;
		}
		track.bitrate = (track.size*8*track.timescale)/track.duration;
		if (sample_desc.isAudio()) {
			movie.audioTracks.push(track);
			track.audio = {};
			track.audio.sample_rate = sample_desc.getSampleRate();		
			track.audio.channel_count = sample_desc.getChannelCount();		
			track.audio.sample_size = sample_desc.getSampleSize();		
		} else if (sample_desc.isVideo()) {
			movie.videoTracks.push(track);
			track.video = {};
			track.video.width = sample_desc.getWidth();		
			track.video.height = sample_desc.getHeight();		
		} else if (sample_desc.isSubtitle()) {
			movie.subtitleTracks.push(track);
		} else if (sample_desc.isHint()) {
			movie.hintTracks.push(track);
		} else if (sample_desc.isMetadata()) {
			movie.metadataTracks.push(track);
		} else {
			movie.otherTracks.push(track);
		}
	}
	return movie;
}

MP4Box.prototype.getInitializationSegment = function() {
	var stream = new DataStream();
	stream.endianness = DataStream.BIG_ENDIAN;
	this.inputIsoFile.writeInitializationSegment(stream);
	return stream.buffer;
}

MP4Box.prototype.writeFile = function() {
	var stream = new DataStream();
	stream.endianness = DataStream.BIG_ENDIAN;
	this.inputIsoFile.write(stream);
	return stream.buffer;
}

MP4Box.prototype.initializeSegmentation = function() {
	var i;
	var j;
	var box;
	var initSegs;
	var trak;
	if (this.onSegment === null) {
		Log.w("MP4Box", "No segmentation callback set!");
	}
	if (!this.isFragmentationStarted) {
		this.isFragmentationStarted = true;		
		this.nextMoofNumber = 0;
		this.inputIsoFile.resetTables();
	}	
	initSegs = [];
	for (i = 0; i < this.fragmentedTracks.length; i++) {
		/* removing all tracks to create initialization segments with only one track */
		for (j = 0; j < this.inputIsoFile.moov.boxes.length; j++) {
			box = this.inputIsoFile.moov.boxes[j];
			if (box && box.type === "trak") {
				this.inputIsoFile.moov.boxes[j].ignore = true;
				this.inputIsoFile.moov.boxes[j] = null;
			}
		}
		/* adding only the needed track */
		trak = this.inputIsoFile.getTrackById(this.fragmentedTracks[i].id);
		delete trak.ignore;
		for (j = 0; j < this.inputIsoFile.moov.boxes.length; j++) {
			box = this.inputIsoFile.moov.boxes[j];
			if (box == null) {
				this.inputIsoFile.moov.boxes[j] = trak;
				break;
			}
		}
		seg = {};
		seg.id = trak.tkhd.track_id;
		seg.user = this.fragmentedTracks[i].user;
		seg.buffer = this.getInitializationSegment();
		initSegs.push(seg);
	}
	return initSegs;
}

/* Called by the application to release the resources associated to samples already forwarded to the application */
MP4Box.prototype.releaseUsedSamples = function (id, sampleNum) {
	var size = 0;
	var trak = this.inputIsoFile.getTrackById(id);
	if (!trak.lastValidSample) trak.lastValidSample = 0;
	for (var i = trak.lastValidSample; i < sampleNum; i++) {
		size+=this.inputIsoFile.releaseSample(trak, i);
	}
	Log.d("MP4Box", "Track #"+id+" released samples up to "+sampleNum+" (total size: "+size+", remaining: "+this.inputIsoFile.samplesDataSize+")");
	trak.lastValidSample = sampleNum;
}

/* Called by the application to flush the remaining samples, once the download is finished */
MP4Box.prototype.flush = function() {
	Log.i("MP4Box", "Flushing remaining samples");
	this.inputIsoFile.updateSampleLists();
	this.processSamples();
}

/* Finds the byte offset for a given time on a given track
   also returns the time of the previous rap */
MP4Box.prototype.seekTrack = function(time, useRap, trak) {
	var j;
	var sample;
	var rap_offset = Infinity;
	var rap_time = 0;
	var seek_offset = Infinity;
	var rap_seek_sample_num = 0;
	var seek_sample_num = 0;
	var timescale;
	for (j = 0; j < trak.samples.length; j++) {
		sample = trak.samples[j];
		if (j === 0) {
			seek_offset = sample.offset;
			seek_sample_num = 0;
			timescale = sample.timescale;
		} else if (sample.cts > time * sample.timescale) {
			seek_offset = trak.samples[j-1].offset;
			seek_sample_num = j-1;
			break;
		} 
		if (useRap && sample.is_rap) {
			rap_offset = sample.offset;
			rap_time = sample.cts;
			rap_seek_sample_num = j;
		}
	}
	if (useRap) {
		trak.nextSample = rap_seek_sample_num;
		Log.i("MP4Box", "Seeking to RAP sample #"+trak.nextSample+" on track "+trak.tkhd.track_id+", time "+Log.getDurationString(rap_time, timescale) +" and offset: "+rap_offset);
		return { offset: rap_offset, time: rap_time/timescale };
	} else {
		trak.nextSample = seek_sample_num;
		Log.i("MP4Box", "Seeking to non-RAP sample #"+trak.nextSample+" on track "+trak.tkhd.track_id+", time "+Log.getDurationString(time)+" and offset: "+rap_offset);
		return { offset: seek_offset, time: time };
	}
}

/* Finds the byte offset in the file corresponding to the given time or to the time of the previous RAP */
MP4Box.prototype.seek = function(time, useRap) {
	var moov = this.inputIsoFile.moov;
	var trak;
	var trak_seek_info;
	var i;
	var seek_info = { offset: Infinity, time: Infinity };
	if (!this.inputIsoFile.moov) {
		throw "Cannot seek: moov not received!";
	} else {
		for (i = 0; i<moov.traks.length; i++) {
			trak = moov.traks[i];			
			trak_seek_info = this.seekTrack(time, useRap, trak);
			if (trak_seek_info.offset < seek_info.offset) {
				seek_info.offset = trak_seek_info.offset;
			}
			if (trak_seek_info.time < seek_info.time) {
				seek_info.time = trak_seek_info.time;
			}
		}
		if (seek_info.offset === Infinity) {
			/* No sample info, in all tracks, cannot seek */
			seek_info = { offset: this.inputIsoFile.nextParsePosition, time: 0 };
		} else {
			var index = this.inputIsoFile.findPosition(true, seek_info.offset);
			if (index !== -1) {
				seek_info.offset = this.inputIsoFile.findEndContiguousBuf(index);
			}
		}
		Log.i("MP4Box", "Seeking at time "+Log.getDurationString(seek_info.time, 1)+" needs a buffer with a fileStart position of "+seek_info.offset);
		return seek_info;
	}
}

},{"./DataStream":165,"./box":166,"./isofile":168,"./log":169}],171:[function(require,module,exports){
(function (Buffer){
var debug = require('debug')('videostream');
var MP4Box = require('mp4box');

var EPSILON = 0.01; // seconds of "slop" in floating-point time calculations
var MAX_BUFFER = 60; // seconds of buffer before pausing the incoming stream

/**
 * Stream data from `file` into `mediaElem`.
 * `file` must be an object with a `length` property giving the file size in bytes,
 * and a `createReadStream(opts)` method that retunr a string and accepts opts.start
 * and opts.end to specify a byte range (inclusive) to fetch.
 * @param {File} file described above
 * @param {HTMLMediaElement} mediaElem <audio> or <video> element
 * @param {Object} opts Options
 * @param {number=} opts.debugTrack Track to save for debugging. Defaults to -1 (none)
 */
module.exports = function (file, mediaElem, opts) {
	opts = opts || {};
	var debugTrack = opts.debugTrack || -1;
	var debugBuffers = [];

	function init () {
		mediaElem.addEventListener('waiting', onWaiting);
		mediaElem.addEventListener('timeupdate', onTimeUpdate);
	}
	init();

	var destroyed = false;
	function destroy (reason) {
		destroyed = true;
		mediaElem.removeEventListener('waiting', onWaiting);
		mediaElem.removeEventListener('timeupdate', onTimeUpdate);
		if (mediaSource.readyState === 'open')
			mediaSource.endOfStream(reason);
	}

	// Determine if it is a good idea to append to the SourceBuffer for the
	// given track, based on how full the browser's buffer is. Returns
	// true if appending is suggested
	function shouldAppend (track) {
		var buffered = track.buffer.buffered;
		var currentTime = mediaElem.currentTime;
		var bufferEnd = -1; // end of the buffer
		// This is a little over complex because some browsers seem to separate the
		// buffered region into multiple sections with slight gaps.
		// TODO: figure out why there are gaps in the buffer. This may be due to
		// timestamp errors in mp4box, or due to browsers not liking the single-frame
		// segments mp4box generates
		for (var i = 0; i < buffered.length; i++) {
			var start = buffered.start(i);
			var end = buffered.end(i) + EPSILON;

			if (start > currentTime) {
				// Reached past the joined buffer
				break;
			} else if (bufferEnd >= 0 || currentTime <= end) {
				// Found the start/continuation of the joined buffer
				bufferEnd = end;
			}
		}

		var bufferedTime = bufferEnd - currentTime;
		if (bufferedTime < 0)
			bufferedTime = 0;

		debug('Buffer length: %f', bufferedTime);

		return bufferedTime <= MAX_BUFFER;
	}

	var mediaSource = new MediaSource();
	mediaSource.addEventListener('sourceopen', function () {
		makeRequest(0);
	});
	mediaElem.src = window.URL.createObjectURL(mediaSource);

	var mp4box = new MP4Box();
	mp4box.onError = function (err) {
		debug('MP4Box error: %s', err.message);
		if(detachStream) {
			detachStream();
		}
		if (mediaSource.readyState === 'open') {
			destroy('decode');
		}
	};
	var ready = false;
	var tracks = {}; // keyed by track id
	mp4box.onReady = function (info) {
		debug('MP4 info: %o', info);
		info.tracks.forEach(function (track) {
			var mime;
			if (track.video) {
				mime = 'video/mp4';
			} else if (track.audio) {
				mime = 'audio/mp4';
			} else {
				return;
			}
			mime += '; codecs="' + track.codec + '"';
			if (MediaSource.isTypeSupported(mime)) {
				var sourceBuffer = mediaSource.addSourceBuffer(mime);
				var trackEntry = {
					buffer: sourceBuffer,
					arrayBuffers: [],
					meta: track,
					ended: false
				};
				sourceBuffer.addEventListener('updateend', popBuffers.bind(null, trackEntry));
				mp4box.setSegmentOptions(track.id, null, {
					// It really isn't that inefficient to give the data to the browser on every frame (for video)
					nbSamples: track.video ? 1 : 100
				});
				tracks[track.id] = trackEntry
			}
		});

		if (Object.keys(tracks).length === 0) {
			destroy('decode');
			return;
		}

		var initSegs = mp4box.initializeSegmentation();
		initSegs.forEach(function (initSegment) {
			appendBuffer(tracks[initSegment.id], initSegment.buffer);
			if (initSegment.id === debugTrack) {
				save('init-track-' + debugTrack + '.mp4', [initSegment.buffer]);
				debugBuffers.push(initSegment.buffer);
			}
		});
		ready = true;
	};

	mp4box.onSegment = function (id, user, buffer, nextSample) {
		var track = tracks[id];
		appendBuffer(track, buffer, nextSample === track.meta.nb_samples);
		if (id === debugTrack && debugBuffers) {
			debugBuffers.push(buffer);
			if (nextSample > 1000) {
				save('track-' + debugTrack + '.mp4', debugBuffers);
				debugBuffers = null;
			}
		}
	};

	var requestOffset; // Position in the file where `stream` will next provide data
	var stream = null;
	var detachStream = null;
	function makeRequest (pos) {
		if (pos === file.length) {
			mp4box.flush(); // All done!
			return;
		}

		if (stream && pos === requestOffset) {
			var toResume = stream;
			// Resume on the next tick
			setTimeout(function () {
				if (stream === toResume)
					stream.resume();
			});
			return; // There is already a stream at the right position, so just let it continue
		}

		if (stream) {
			stream.destroy(); // There is a stream, but not at the right position
			detachStream();
		}

		requestOffset = pos;
		var opts = {
			start: requestOffset,
			end: file.length - 1
		};
		// There is necessarily only one stream that is not detached/destroyed at one time,
		// so it's safe to overwrite the var from the outer scope
		stream = file.createReadStream(opts);
		function onData (data) {
			// Pause the stream and resume it on the next run of the event loop to avoid
			// lots of 'data' event blocking the UI
			stream.pause();

			var arrayBuffer = new Buffer(data).buffer; // TODO: avoid copy
			arrayBuffer.fileStart = requestOffset;
			requestOffset += arrayBuffer.byteLength;
			var nextOffset;
			try {
				// MP4Box tends to blow up ungracefully when it can't parse the mp4 input, so
				// use a try/catch
				nextOffset = mp4box.appendBuffer(arrayBuffer);
				// // Prevent infinte loops if mp4box keeps requesting the same data
				// if (nextOffset === arrayBuffer.fileStart) {
				// 	throw new Error('MP4Box parsing stuck at offset: ' + nextOffset);
				// }
			} catch (err) {
				debug('MP4Box threw exception: %s', err.message);
				// This will fire the 'error' event on the audio/video element
				if (mediaSource.readyState === 'open') {
					destroy('decode');
				}
				stream.destroy();
				detachStream();
				return;
			}
			makeRequest(nextOffset);
		}
		stream.on('data', onData);
		function onEnd () {
			detachStream();
			makeRequest(requestOffset);
		}
		stream.on('end', onEnd);
		function onStreamError (err) {
			debug('Stream error: %s', err.message);
			if (mediaSource.readyState === 'open') {
				destroy('network');
			}
		}
		stream.on('error', onStreamError);

		detachStream = function () {
			stream.removeListener('data', onData);
			stream.removeListener('end', onEnd);
			stream.removeListener('error', onStreamError);
			stream = null;
			detachStream = null;
		}
	}

	function onWaiting () {
		if (ready) {
			seek(mediaElem.currentTime);
		}
	}

	function seek (seconds) {
		if (destroyed)
			init();

		var seekResult = mp4box.seek(seconds, true);
		debug('Seeking to time: %d', seconds);
		debug('Seeked file offset: %d', seekResult.offset);
		makeRequest(seekResult.offset);
	}

	function appendBuffer (track, buffer, ended) {
		track.arrayBuffers.push({
			buffer: buffer,
			ended: ended || false
		});
		popBuffers(track);
	}

	// Potentially call popBuffers() again. Call this whenever
	// the buffer may have become less full (i.e. on timeupdate)
	function onTimeUpdate () {
		Object.keys(tracks).forEach(function (id) {
			var track = tracks[id];
			if (track.blocked) {
				popBuffers(track);
			}
		});
	}

	function popBuffers (track) {
		if (track.buffer.updating)
			return;

		track.blocked = !shouldAppend(track);
		if (track.blocked)
			return;

		if (track.arrayBuffers.length === 0)
			return;
		var buffer = track.arrayBuffers.shift();
		var appended = false;
		try {
			track.buffer.appendBuffer(buffer.buffer);
			track.ended = buffer.ended;
			appended = true;
		} catch (err) {
			debug('SourceBuffer error: %s', err.message);
			destroy('decode');
			return;
		}
		if (appended) {
			updateEnded(); // call mediaSource.endOfStream() if needed
		}
	}

	function updateEnded () {
		if (mediaSource.readyState !== 'open') {
			return;
		}

		var ended = Object.keys(tracks).every(function (id) {
			var track = tracks[id];
			return track.ended && !track.buffer.updating;
		});

		if (ended) {
			destroy();
		}
	}
};

/**
  Saves an array of ArrayBuffers to the given filename.
  @param {string} filename Filename to save as.
  @param {Array.<ArrayBuffer>}
  */
function save (filename, buffers) {
	var blob = new Blob(buffers);
	var url = URL.createObjectURL(blob);
	var a = document.createElement('a');
	a.setAttribute('href', url);
	a.setAttribute('download', filename);
	a.click();
 }

}).call(this,require("buffer").Buffer)
},{"buffer":25,"debug":93,"mp4box":170}],172:[function(require,module,exports){
module.exports = extend

var hasOwnProperty = Object.prototype.hasOwnProperty;

function extend() {
    var target = {}

    for (var i = 0; i < arguments.length; i++) {
        var source = arguments[i]

        for (var key in source) {
            if (hasOwnProperty.call(source, key)) {
                target[key] = source[key]
            }
        }
    }

    return target
}

},{}],173:[function(require,module,exports){
module.exports = extend

var hasOwnProperty = Object.prototype.hasOwnProperty;

function extend(target) {
    for (var i = 1; i < arguments.length; i++) {
        var source = arguments[i]

        for (var key in source) {
            if (hasOwnProperty.call(source, key)) {
                target[key] = source[key]
            }
        }
    }

    return target
}

},{}],174:[function(require,module,exports){
/**
 * Given a number, return a zero-filled string.
 * From http://stackoverflow.com/questions/1267283/
 * @param  {number} width
 * @param  {number} number
 * @return {string}
 */
module.exports = function zeroFill (width, number, pad) {
  if (number === undefined) {
    return function (number, pad) {
      return zeroFill(width, number, pad)
    }
  }
  if (pad === undefined) pad = '0'
  width -= number.toString().length
  if (width > 0) return new Array(width + (/\./.test(number) ? 2 : 1)).join(pad) + number
  return number + ''
}

},{}],175:[function(require,module,exports){
module.exports={"version":"0.90.0"}
},{}],176:[function(require,module,exports){
(function (process,global,Buffer){
module.exports = WebTorrent

var createTorrent = require('create-torrent')
var debug = require('debug')('webtorrent')
var DHT = require('bittorrent-dht/client') // browser exclude
var EventEmitter = require('events').EventEmitter
var extend = require('xtend')
var hat = require('hat')
var inherits = require('inherits')
var loadIPSet = require('load-ip-set') // browser exclude
var parallel = require('run-parallel')
var parseTorrent = require('parse-torrent')
var path = require('path')
var Peer = require('simple-peer')
var speedometer = require('speedometer')
var zeroFill = require('zero-fill')

var concatStream = require('./lib/concat-stream')
var Torrent = require('./lib/torrent')

module.exports.WEBRTC_SUPPORT = Peer.WEBRTC_SUPPORT

/**
 * WebTorrent version.
 */
var VERSION = require('./package.json').version

/**
 * Version number in Azureus-style. Generated from major and minor semver version.
 * For example:
 *   '0.16.1' -> '0016'
 *   '1.2.5' -> '0102'
 */
var VERSION_STR = VERSION.match(/([0-9]+)/g).slice(0, 2).map(zeroFill(2)).join('')

/**
 * Version prefix string (used in peer ID). WebTorrent uses the Azureus-style
 * encoding: '-', two characters for client id ('WW'), four ascii digits for version
 * number, '-', followed by random numbers.
 * For example:
 *   '-WW0102-'...
 */
var VERSION_PREFIX = '-WW' + VERSION_STR + '-'

inherits(WebTorrent, EventEmitter)

/**
 * WebTorrent Client
 * @param {Object=} opts
 */
function WebTorrent (opts) {
  var self = this
  if (!(self instanceof WebTorrent)) return new WebTorrent(opts)
  EventEmitter.call(self)

  if (!opts) opts = {}

  self.destroyed = false
  self.torrentPort = opts.torrentPort || 0
  self.tracker = opts.tracker !== undefined ? opts.tracker : true

  self._rtcConfig = opts.rtcConfig
  self._wrtc = opts.wrtc || global.WRTC // to support `webtorrent-hybrid` package

  self.torrents = []

  self._downloadSpeed = speedometer()
  self._uploadSpeed = speedometer()

  self.maxConns = opts.maxConns

  self.peerId = typeof opts.peerId === 'string'
    ? opts.peerId
    : (opts.peerId || new Buffer(VERSION_PREFIX + hat(48))).toString('hex')
  self.peerIdBuffer = new Buffer(self.peerId, 'hex')

  self.nodeId = typeof opts.nodeId === 'string'
    ? opts.nodeId
    : (opts.nodeId && opts.nodeId.toString('hex')) || hat(160)
  self.nodeIdBuffer = new Buffer(self.nodeId, 'hex')

  if (opts.dht !== false && typeof DHT === 'function' /* browser exclude */) {
    // use a single DHT instance for all torrents, so the routing table can be reused
    self.dht = new DHT(extend({ nodeId: self.nodeId }, opts.dht))
    self.dht.once('error', function (err) {
      self.emit('error', err)
      self.destroy()
    })

    // Ignore warning when there are > 10 torrents in the client
    self.dht.setMaxListeners(0)

    self.dht.listen(opts.dhtPort)
  } else {
    self.dht = false
  }

  debug('new webtorrent (peerId %s, nodeId %s)', self.peerId, self.nodeId)

  if (typeof loadIPSet === 'function') {
    loadIPSet(opts.blocklist, {
      headers: { 'user-agent': 'WebTorrent/' + VERSION + ' (http://webtorrent.io)' }
    }, function (err, ipSet) {
      if (err) return self.error('Failed to load blocklist: ' + err.message)
      self.blocked = ipSet
      ready()
    })
  } else process.nextTick(ready)

  function ready () {
    if (self.destroyed) return
    self.ready = true
    self.emit('ready')
  }
}

Object.defineProperty(WebTorrent.prototype, 'downloadSpeed', {
  get: function () { return this._downloadSpeed() }
})

Object.defineProperty(WebTorrent.prototype, 'uploadSpeed', {
  get: function () { return this._uploadSpeed() }
})

Object.defineProperty(WebTorrent.prototype, 'progress', {
  get: function () {
    var torrents = this.torrents.filter(function (torrent) {
      return torrent.progress !== 1
    })
    var downloaded = torrents.reduce(function (total, torrent) {
      return total + torrent.downloaded
    }, 0)
    var length = torrents.reduce(function (total, torrent) {
      return total + (torrent.length || 0)
    }, 0) || 1
    return downloaded / length
  }
})

Object.defineProperty(WebTorrent.prototype, 'ratio', {
  get: function () {
    var uploaded = this.torrents.reduce(function (total, torrent) {
      return total + torrent.uploaded
    }, 0)
    var downloaded = this.torrents.reduce(function (total, torrent) {
      return total + torrent.downloaded
    }, 0) || 1
    return uploaded / downloaded
  }
})

/**
 * Returns the torrent with the given `torrentId`. Convenience method. Easier than
 * searching through the `client.torrents` array. Returns `null` if no matching torrent
 * found.
 *
 * @param  {string|Buffer|Object|Torrent} torrentId
 * @return {Torrent|null}
 */
WebTorrent.prototype.get = function (torrentId) {
  var self = this
  if (torrentId instanceof Torrent) return torrentId

  var parsed
  try { parsed = parseTorrent(torrentId) } catch (err) {}

  if (!parsed) return null
  if (!parsed.infoHash) throw new Error('Invalid torrent identifier')

  for (var i = 0, len = self.torrents.length; i < len; i++) {
    var torrent = self.torrents[i]
    if (torrent.infoHash === parsed.infoHash) return torrent
  }
  return null
}

/**
 * Start downloading a new torrent. Aliased as `client.download`.
 * @param {string|Buffer|Object} torrentId
 * @param {Object} opts torrent-specific options
 * @param {function=} ontorrent called when the torrent is ready (has metadata)
 */
WebTorrent.prototype.add =
WebTorrent.prototype.download = function (torrentId, opts, ontorrent) {
  var self = this
  if (self.destroyed) throw new Error('client is destroyed')
  if (typeof opts === 'function') return self.add(torrentId, null, opts)

  debug('add')
  opts = opts ? extend(opts) : {}

  var torrent = self.get(torrentId)

  if (torrent) {
    if (torrent.ready) process.nextTick(onReady)
    else torrent.once('ready', onReady)
  } else {
    torrent = new Torrent(torrentId, self, opts)
    self.torrents.push(torrent)

    torrent.once('error', function (err) {
      self.emit('error', err, torrent)
      self.remove(torrent)
    })

    torrent.once('listening', function (port) {
      self.emit('listening', port, torrent)
    })

    torrent.once('ready', onReady)
  }

  function onReady () {
    debug('on torrent')
    if (typeof ontorrent === 'function') ontorrent(torrent)
    self.emit('torrent', torrent)
  }

  return torrent
}

/**
 * Start seeding a new file/folder.
 * @param  {string|File|FileList|Buffer|Array.<string|File|Buffer>} input
 * @param  {Object=} opts
 * @param  {function=} onseed called when torrent is seeding
 */
WebTorrent.prototype.seed = function (input, opts, onseed) {
  var self = this
  if (self.destroyed) throw new Error('client is destroyed')
  if (typeof opts === 'function') return self.seed(input, null, opts)

  debug('seed')
  opts = opts ? extend(opts) : {}

  // When seeding from fs path, initialize store from that path to avoid a copy
  if (typeof input === 'string') opts.path = path.dirname(input)
  if (!opts.createdBy) opts.createdBy = 'WebTorrent/' + VERSION_STR
  if (!self.tracker) opts.announce = []

  var torrent = self.add(null, opts, onTorrent)
  var streams

  if (!Array.isArray(input)) input = [ input ]
  parallel(input.map(function (item) {
    return function (cb) {
      if (isReadable(item)) concatStream(item, cb)
      else cb(null, item)
    }
  }), function (err, input) {
    if (err) return self.emit('error', err, torrent)
    if (self.destroyed) return
    createTorrent.parseInput(input, opts, function (err, files) {
      if (err) return self.emit('error', err, torrent)
      if (self.destroyed) return
      streams = files.map(function (file) { return file.getStream })

      createTorrent(input, opts, function (err, torrentBuf) {
        if (err) return self.emit('error', err, torrent)
        if (self.destroyed) return

        var existingTorrent = self.get(torrentBuf)
        if (existingTorrent) {
          torrent.destroy()
          _onseed(existingTorrent)
        } else {
          torrent._onTorrentId(torrentBuf)
        }
      })
    })
  })

  function onTorrent (torrent) {
    var tasks = [
      function (cb) {
        torrent.load(streams, cb)
      }
    ]
    if (self.dht) {
      tasks.push(function (cb) {
        torrent.once('dhtAnnounce', cb)
      })
    }
    parallel(tasks, function (err) {
      if (self.destroyed) return
      if (err) return self.emit('error', err, torrent)
      _onseed(torrent)
    })
  }

  function _onseed (torrent) {
    debug('on seed')
    if (typeof onseed === 'function') onseed(torrent)
    self.emit('seed', torrent)
  }

  return torrent
}

/**
 * Remove a torrent from the client.
 * @param  {string|Buffer|Torrent}   torrentId
 * @param  {function} cb
 */
WebTorrent.prototype.remove = function (torrentId, cb) {
  var self = this
  debug('remove')

  var torrent = self.get(torrentId)
  if (!torrent) throw new Error('No torrent with id ' + torrentId)

  self.torrents.splice(self.torrents.indexOf(torrent), 1)
  torrent.destroy(cb)
}

WebTorrent.prototype.address = function () {
  var self = this
  return { address: '0.0.0.0', family: 'IPv4', port: self.torrentPort }
}

/**
 * Destroy the client, including all torrents and connections to peers.
 * @param  {function} cb
 */
WebTorrent.prototype.destroy = function (cb) {
  var self = this
  if (self.destroyed) throw new Error('client already destroyed')
  self.destroyed = true
  debug('destroy')

  var tasks = self.torrents.map(function (torrent) {
    return function (cb) { self.remove(torrent, cb) }
  })

  if (self.dht) tasks.push(function (cb) { self.dht.destroy(cb) })

  parallel(tasks, cb)
}

/**
 * Check if `obj` is a node Readable stream
 * @param  {*} obj
 * @return {boolean}
 */
function isReadable (obj) {
  return typeof obj === 'object' && obj != null && typeof obj.pipe === 'function'
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},require("buffer").Buffer)
},{"./lib/concat-stream":1,"./lib/torrent":7,"./package.json":175,"_process":33,"bittorrent-dht/client":24,"buffer":25,"create-torrent":61,"debug":93,"events":29,"hat":99,"inherits":101,"load-ip-set":24,"parse-torrent":105,"path":32,"run-parallel":139,"simple-peer":143,"speedometer":149,"xtend":172,"zero-fill":174}]},{},[176])(176)
});