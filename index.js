var dgram = require('dgram');
var dns = require('dns');
var cyclist = require('cyclist');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var Duplex = require('stream').Duplex;

var EXTENSION = 0;
var VERSION   = 1;
var UINT16    = 0xffff;
var ID_MASK   = 0xf << 4;
var MTU       = 1400;

var PACKET_DATA  = 0 << 4;
var PACKET_FIN   = 1 << 4;
var PACKET_STATE = 2 << 4;
var PACKET_RESET = 3 << 4;
var PACKET_SYN   = 4 << 4;

var EXT_SELECTIVE_ACK = 1;
var EXT_METADATA      = 2;

var MIN_PACKET_SIZE = 20;
var DEFAULT_WINDOW_SIZE = 1 << 18;
var CLOSE_GRACE = 5000;

var BUFFER_SIZE = 512;

var uint32 = function(n) {
	return n >>> 0;
};

var uint16 = function(n) {
	return n & UINT16;
};

var timestamp = function() {
	var offset = process.hrtime();
	var then = Date.now() * 1000;

	return function() {
		var diff = process.hrtime(offset);
		return uint32(then + 1000000 * diff[0] + ((diff[1] / 1000) | 0));
	};
}();

var readExtensionMetadata = function(packet, ext) {
	ext.dataString = ext.data.toString();
	packet.metadata = ext.data;
};

var writeExtensionMetadata = function(packet, ext) {
	if(typeof(ext.data) == 'string') ext.data = new Buffer(ex.data);
};

var bufferToPacket = function(buffer) {
	var packet = {};
	packet.id = buffer[0] & ID_MASK;
	var ext = buffer[1];
	packet.connection = buffer.readUInt16BE(2);
	packet.timestamp = buffer.readUInt32BE(4);
	packet.timediff = buffer.readUInt32BE(8);
	packet.window = buffer.readUInt32BE(12);
	packet.seq = buffer.readUInt16BE(16);
	packet.ack = buffer.readUInt16BE(18);
	packet.extensions = [];
	var data = 20;
	while(ext != 0) {
		var next_ext = buffer[data];
		var ext_len  = buffer[data+1];
		var ext_data = buffer.slice(data + 2, data + 2 + len);
		var ext_body = {
			type: ext,
			len:  ext_len,
			data: ext_data
		};
		if(ext == EXT_METADATA) readExtensionMetadata(packet, ext);
		packet.extensions.push(ext_body);
		data = data + 2 + len;
		ext = next_ext;
	}
	packet.data = buffer.length > data ? buffer.slice(data) : null;
	return packet;
};

var packetToBuffer = function(packet) {
	var extlength = 0;
	for(var i = 0; i < packet.extensions.length; i++) {
		var ext  = packet.extensions[i];
		var next = packet.extensions[i + 1] || {type: 0};
		ext.nextType = next.type;
		if(ext.type == EXT_METADATA) writeExtensionMetadata(packet, ext);
		extlength += 2 + ext.data.length;
	}
	var buffer = new Buffer(20 + extlength + (packet.data ? packet.data.length : 0));
	buffer[0] = packet.id | VERSION;
	buffer[1] = EXTENSION;
	buffer.writeUInt16BE(packet.connection, 2);
	buffer.writeUInt32BE(packet.timestamp, 4);
	buffer.writeUInt32BE(packet.timediff, 8);
	buffer.writeUInt32BE(packet.window, 12);
	buffer.writeUInt16BE(packet.seq, 16);
	buffer.writeUInt16BE(packet.ack, 18);
	var extpos = 20;
	for(var i = 0; i < packet.extensions.length; i++) {
		var ext = packet.extensions[i];
		buffer[extpos++] = ext.nextType;
		buffer[extpos++] = ext.data.length;
		ext.data.copy(buffer, extpos);
		extpos += ext.data.length;
	}
	if (packet.data) packet.data.copy(buffer, extpos);
	return buffer;
};

var createPacket = function(connection, id, data, metadata) {
	var exts = [];
	if(metadata) exts.push({type: EXT_METADATA, data: metadata});
	return {
		id: id,
		connection: id === PACKET_SYN ? connection._recvId : connection._sendId,
		seq: connection._seq,
		ack: connection._ack,
		timestamp: timestamp(),
		timediff: 0,
		window: DEFAULT_WINDOW_SIZE,
		extensions: exts,
		data: (typeof(data) == 'string') ? new Buffer(data) : data,
		sent: 0
	};
};

var Connection = function(port, host, socket, opts, syn) {
	if(syn === undefined) {
		syn = opts;
		opts = {};
	}
	opts = opts || {}
	
	var parentOpts = {};
	if(opts.objectMode) parentOpts.objectMode = true;

	Duplex.call(this, parentOpts);
	var self = this;

	this.port = port;
	this.host = host;
	this.socket = socket;

	this._outgoing = cyclist(BUFFER_SIZE);
	this._incoming = cyclist(BUFFER_SIZE);

	this._inflightPackets = 0;
	this._closed = false;
	this._alive = false;
	this._connectingTimeout = undefined;

	if(typeof syn == 'number') {
		this._connecting = true;
		this._recvId = syn;
		this._sendId = uint16(this._recvId + 1);
		this._seq = (Math.random() * UINT16) | 0;
		this._ack = 0;

		this._sendOutgoing(createPacket(self, PACKET_SYN, opts.data || null));
	} else if(typeof syn == 'function') {
		this._connecting = true;
		this._recvId = 0; // tmp value for v8 opt
		this._sendId = 0; // tmp value for v8 opt
		this._seq = (Math.random() * UINT16) | 0;
		this._ack = 0;

		syn(this, function(recvId){
			self._recvId = recvId;
			self._sendId = uint16(self._recvId + 1);
			self._sendOutgoing(createPacket(self, PACKET_SYN, opts.data || null));
		});
	} else {
		this._connecting = true;
		this._recvId = 0;
		this._sendId = 0;
		this._seq = (Math.random() * UINT16) | 0;
		this._ack = 0;
	}

	// Default timeout of 5s when initiate a connection. No timeout during
	// connection
	if(opts.timeout === undefined) opts.timeout = 5000;
	if(opts.timeout) this._connectingTimeout = setTimeout(connectionTimedOut, opts.timeout);

	var resend = setInterval(this._resend.bind(this), 500);
	var keepAlive = setInterval(this._keepAlive.bind(this), 10*1000);
	var tick = 0;

	var closed = function() {
		if (++tick === 2) self._closing();
	};

	var sendFin = function() {
		if (self._connecting) return self.once('connect', sendFin);
		self._sendOutgoing(createPacket(self, PACKET_FIN, null));
		self.once('flush', closed);
	};

	this.once('finish', sendFin);
	this.once('close', function() {
		if (!syn && syn !== 0) setTimeout(socket.close.bind(socket), CLOSE_GRACE);
		clearInterval(resend);
		clearInterval(keepAlive);
	});
	this.once('end', function() {
		process.nextTick(closed);
	});
	
	function connectionTimedOut() {
		self.emit('timeout');
		self.end();
		self.push(null);
		self._closing();
	};
};

util.inherits(Connection, Duplex);

Connection.prototype.setTimeout = function() {
	// TODO: impl me
};

Connection.prototype.destroy = function() {
	this.end();
};

Connection.prototype.address = function() {
	return {port:this.port, address:this.host};
};

Connection.prototype._read = function() {
	// do nothing...
};

Connection.prototype._write = function(data, enc, callback) {
	if(typeof(data) == 'string') data = new Buffer(data);

	// If connecting, delay write until we are connected
	if (this._connecting) return this._writeOnce('connect', data, enc, callback);
	
	var meta = data.meta;

	// Send data until the window is full
	while (this._writable()) {
		var payload = this._payload(data);

		this._sendOutgoing(createPacket(this, PACKET_DATA, payload, meta));

		if (payload.length === data.length) return callback();
		data = data.slice(payload.length);
		data.meta = meta;
	}

	// Send the rest of the data later when the window is flushed
	this._writeOnce('flush', data, enc, callback);
};

Connection.prototype._writeOnce = function(event, data, enc, callback) {
	this.once(event, function() {
		this._write(data, enc, callback);
	});
};

Connection.prototype._writable = function() {
	return this._inflightPackets < BUFFER_SIZE-1;
};

Connection.prototype._payload = function(data) {
	if (data.length > MTU) return data.slice(0, MTU);
	return data;
};

Connection.prototype._resend = function() {
	var offset = this._seq - this._inflightPackets;
	var first = this._outgoing.get(offset);
	if (!first) return;

	var timeout = 500000;
	var now = timestamp();

	if (uint32(first.sent - now) < timeout) return;

	for (var i = 0; i < this._inflightPackets; i++) {
		var packet = this._outgoing.get(offset+i);
		if (uint32(packet.sent - now) >= timeout) this._transmit(packet);
	}
};

Connection.prototype._keepAlive = function() {
	if (this._alive) return this._alive = false;
	this._sendAck();
};

Connection.prototype._closing = function() {
	if (this._closed) return;
	this._closed = true;
	process.nextTick(this.emit.bind(this, 'close'));
};

// packet handling

Connection.prototype._recvAck = function(ack) {
	var offset = this._seq - this._inflightPackets;
	var acked = uint16(ack - offset)+1;

	if (acked >= BUFFER_SIZE) return; // sanity check

	for (var i = 0; i < acked; i++) {
		this._outgoing.del(offset+i);
		this._inflightPackets--;
	}

	if (!this._inflightPackets) this.emit('flush');
};

Connection.prototype._recvIncoming = function(packet) {
	if (this._closed) return;

	if (packet.id === PACKET_RESET) {
		this.push(null);
		this.end();
		this._closing();
		return;
	}

	if(this._connecting) {
		if(this._recvId === this._sendId) {

			// Expect to receive a SYN packet

			if (packet.id !== PACKET_SYN) {
				this._transmit(createPacket(this, PACKET_RESET, null));
				this.push(null);
				this.end();
				this._closing();
				return;
			}

			this._connecting = false;
			if(this._connectingTimeout) clearTimeout(this._connectingTimeout);
			this._recvId = uint16(packet.connection+1);
			this._sendId = packet.connection;
			this._ack = packet.seq;
			this._transmit(createPacket(this, PACKET_STATE, null));
			if(packet.data) {
				if(packet.metadata) packet.data.meta = packet.metadata
				this.push(packet.data);
			}
			return;

		} else {

			// Sent a SYN packet, expect to receive a STATE packet
			
			if (packet.id !== PACKET_STATE) {
				// Consider STATE packet was not received, store the packet in queue
				return this._incoming.put(packet.seq, packet);
			}

			this._ack = uint16(packet.seq-1);
		}
	}

	if (uint16(packet.seq - this._ack) >= BUFFER_SIZE) {
		// Received packet too old for out buffer
		return this._sendAck();
	}

	this._recvAck(packet.ack); // TODO: other calcs as well

	if(this._connecting) {
		this._connecting = false;
		if(this._connectingTimeout) clearTimeout(this._connectingTimeout);
		this.emit('connect');
	}
	
	if (packet.id === PACKET_STATE && !this._incoming.get(this._ack+1)) return;

	this._incoming.put(packet.seq, packet);

	while (packet = this._incoming.del(this._ack+1)) {
		this._ack = uint16(this._ack+1);
		
		if (packet.data && packet.metadata) packet.data.meta = packet.metadata

		if (packet.id === PACKET_FIN)  this.push(null);
		if (packet.id === PACKET_DATA) this.push(packet.data);
	}

	this._sendAck();
};

Connection.prototype._sendAck = function() {
	this._transmit(createPacket(this, PACKET_STATE, null)); // TODO: make this delayed
};

Connection.prototype._sendOutgoing = function(packet) {
	this._outgoing.put(packet.seq, packet);
	this._seq = uint16(this._seq + 1);
	this._inflightPackets++;
	this._transmit(packet);
};

Connection.prototype._transmit = function(packet) {
	packet.sent = packet.sent === 0 ? packet.timestamp : timestamp();
	var message = packetToBuffer(packet);
	this._alive = true;
	this.socket.send(message, 0, message.length, this.port, this.host);
};


var Server = function() {
	EventEmitter.call(this);
	this._socket = null;
	this._connections = {};
};

util.inherits(Server, EventEmitter);

Server.prototype.address = function() {
	return this._socket.address();
};

Server.prototype.close = function() {
	this._socket.close();
	delete this._socket;
	this._socket = null;
	this._connections = {};
}

Server.prototype.listen = function(port, socket, onlistening, onerror) {
	if(typeof socket == 'function') {
		onerror = onlistening;
		onlistening = socket;
		socket = dgram.createSocket('udp4');
	} else if(typeof socket == 'string') {
		socket = dgram.createSocket(socket);
	}
	this._socket = socket;
	this._closed = false;
	var connections = this._connections;
	var self = this;

	socket.on('message', function(message, rinfo) {
		if (message.length < MIN_PACKET_SIZE) return;
		var packet = bufferToPacket(message);
		var id = rinfo.address+':'+(packet.id === PACKET_SYN ? uint16(packet.connection+1) : packet.connection);
		
		if(connections[id]) {
			return connections[id]._recvIncoming(packet);
		} else if(packet.id === PACKET_SYN) {
			connections[id] = new Connection(rinfo.port, rinfo.address, socket, self.connectionOptions);
			connections[id].on('close', function() {
				delete connections[id];
			});
			self.emit('connection', connections[id]);
			connections[id]._recvIncoming(packet);
		}
	});

	socket.once('listening', function() {
		self.emit('listening');
		onerror = undefined;
	});

	socket.once('error', function(e) {
		if(onerror) onerror(e);
	});

	socket.once('close', function(e) {
		self._closed = true;
	});

	if (onlistening) self.once('listening', onlistening);

	socket.bind(port);
};

Server.prototype.connect = function(port, host, opts, callback) {
	if(typeof opts == 'function') {
		callback = opts;
		opts = null;
	}
	var self = this;
	dns.lookup(host || '127.0.0.1', function(err, addr, family){
		if(!err && self._closed) err = new Error("Server stopped");
		if(err) return callback(err);
		else    return callback(null, self.connectAddr(port, addr, opts));
	});
};

Server.prototype.connectAddr = function(port, address, opts) {
	// FIXME: if called directly, the IP address might be in a non normalized
	// state (leading zeros, uppercase/lowercase differences, IPv6 '::') that may
	// lead to an incorrect connection id (variable `id`). use `connect` instead
	// of `connectAddr`  in those cases. It does normalization.
	if(this._closed) throw new Error("Connection closed");
	address = address || '127.0.0.1';
	var connId = this._getNewConnectionId(address);
	var connection = new Connection(port, address, this._socket, opts, connId);
	var id = address + ':' + connId;
	this._connections[id] = connection;
	return connection;
};

Server.prototype._getNewConnectionId = function(address) {
	var id = (Math.random() * UINT16) | 0;
	while(id === undefined || this._connections[address + ':' + id]) {
		id = uint16(id + 1);
	}
	return id;
}

exports.createServer = function(onconnection) {
	var server = new Server();
	if (onconnection) server.on('connection', onconnection);
	return server;
};

exports.connect = function(port, host, socket, opts) {
	if(!socket) {
		socket = dgram.createSocket('udp4');
	} else if(typeof socket == 'string') {
		socket = dgram.createSocket(socket);
	}

	var connection = new Connection(port, host || '127.0.0.1', socket, opts, function(conn, cb){
		socket.on('listening', function() {
			cb(socket.address().port); // using the port gives us system wide clash protection
		});

		socket.on('error', function(err) {
			conn.emit('error', err);
		});

		socket.bind();
	});

	socket.on('message', function(message) {
		if (message.length < MIN_PACKET_SIZE) return;
		var packet = bufferToPacket(message);

		if (packet.id === PACKET_SYN) return;
		if (packet.connection !== connection._recvId) return;

		connection._recvIncoming(packet);
	});

	return connection;
};
