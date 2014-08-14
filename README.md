# utp

utp (micro transport protocol) implementation in node.
It is available through npm

	npm install utp

## What is utp?

utp (micro transport protocol, can also be abbreviated with µtp) is a network
protocol similar to tcp that runs on top of udp. Since it build on top of udp
it can provide great peer to peer connectivity through techniques like hole
punching and similar while still providing a stream interface. It also features
a congestion algorithm designed to keep TCP streams at the higher priority.
It is currently the main network protocol powering bittorrent.

Specification is available here: [http://www.bittorrent.org/beps/bep_0029.html]

## BEWARE BEWARE BEWARE

*This module is a work in progress! So beware of dragons!*

## Usage

utp has the same interface as the net module in node.

``` js
var utp = require('utp');

var server = utp.createServer(function(socket) {
	console.log('new connection!');
	client.on('data', function(data) {
		console.log('client says '+data);
	});
});

server.listen(10000, function() {
	var client = utp.connect(10000, 'localhost');

	client.write('hello world');
});
```

`server.listen()` also accepts a udp socket to listen on instead of a port.


## Reference

### utp.createServer([onconnection])

Create a new server, set up the `connection` event with the event handler
`onconnection` (if it was provided). Return an object derived from `Server`.

### utp.connect(port, host, [socket, [opts]])

* `host`: the host to connect to
* `port`: the UDP port to connect to
* `socket`: a datagram socket, or a socket type such as `'udp4'` or `'udp6'` (optional)
* `opts`: option object for the connection
* return an object derived from `Connection`

The connection is not yet established at this point. Use the `'connect'` event
to ensure the other end accepted the connection.

If the socket cannot be opened, an `error` event will be fired.

### Server

#### Server.prototype.address()

Same as calling `address()` on the UDP socket.

#### Server.prototype.listen(port, [socket], [onlistening])

* `port`: the UDP port to connect to
* `socket`: a datagram socket, or a socket type such as `'udp4'` or `'udp6'` (optional)
* `onlistening`: a callback hooked to the `'listening'` event (optional)

Listen to the specified port using the given socket.

#### Server.prototype.connect(port, host, [opts], callback)

Establish a new connection to the remote `host` and `port`. A new connection
identifier will be chosen such as multiple connections to the same destination
can coexist. `opts` are options passed to the `Connection` object. When the
connection is started, the `callback` will be called with:

* `err`: any error or `null`
* `connection`: the `Connection` object

The connection is not yet established at this point. Use the `'connect'` event
to ensure the other end accepted the connection.

#### Server.prototype.connectAddr(port, address, [opts])

Establish a new connection to the remote `address` and `port`. A new connection
identifier will be chosen such as multiple connections to the same destination
can coexist. `opts` are options passed to the `Connection` object. The
connection is returned.

**Note: the `address` argument should be a normalized IP address or else the
server won't be able to track the connection. Use `connect` if you are unsure,
it will resolve the host name or address.**

#### Server.prototype.connectionOptions

Options to pass to new connections when they are accepted.

#### Event 'listening'

Emitted when the UDP socket emits `'listening'`

#### Event 'connection'

Emitted when a clients attemps to connect to the server. The `Connection` object
is passed as argument.

### Connection

A `Connection` oject inherits from `stream.Duplex` and implements both the
`Readable` and `Writeable` interfaces. It can be configured with options.
Options should be an object with the following keys:

* `objectMode`: puts the stream in object mode. Once in object mode, the data is
  ensured to be split at the same boundaries as the packets on the network. When
  receiving and sending data, the Buffer object has an additional `meta`
  property that can be read for received data and set for data to be sent and
  that corresponds to the content of the metadata extension.

* `data`: initial data to include on the SYN packet and that will be part of the
  stream. This is an extension to the protocol and avoids an additional round
  trip.

#### Connection.prototype.address()

Return the remote address and port in the form `{host: ..., port: ...}`

#### Event 'connect'

When initiating the connection, this event is emitted when the other end
accepted the connection.

#### Event 'timeout'

When initiating the connection, this event is emitted when the other end
is not responding at all. The timeout is 5 seconds by default and can be
configured with `opts.timeout`.


## Extensions to the protocol

This library extends the protocol in two ways:

* It is possible to send data on the first packet, when initiating the
  connection. The SYN packet have additional data that are inserted in the
  stream.

* A new extension header (identified by extension number 2) has been
  introduced. It provides additional metadata to the payload. In order to use
  this facility, you have to write a Buffer object that has a meta property
  containing the metadata to send. When receiving a buffer, the meta property
  will be set as well.
  
  Example for sending metadata:
  
        buffer = new Buffer();     // must be a Buffer
        buffer.meta = "request-1"; // could be string or Buffer
        utp.write(buffer);

  Example for receiving metadata:
  
        var currentRequest = null;
        var requestData = []
        utp.on('data', function(buf){
          var meta = buf.meta.toString();
          if(currentRequest != meta && requestData.length > 0) {
            var req = Buffer.concat(requestData);
            ...
            requestData = [];
          }
          currentRequest = meta;
          requestData.push(buf);
        });

  Note that setting metadata will necessary split packets if the metatadata is
  changing at some point.
  
  This can be very useful to send frames within the stream. Frame boundaries can
  be expressed by metadata change.


## License

MIT
