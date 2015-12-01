βTorrent
========

Current stable release: v0.5.3

[![Build Status](https://travis-ci.org/whitef0x0/Btorrent.svg?branch=master)](https://travis-ci.org/whitef0x0/Btorrent)
[![Dependency Status](https://gemnasium.com/whitef0x0/Btorrent.svg)](https://gemnasium.com/whitef0x0/Btorrent)
[![Coverage Status](https://coveralls.io/repos/whitef0x0/Btorrent/badge.svg?branch=master&service=github)](https://coveralls.io/github/whitef0x0/Btorrent?branch=master)
[![Code Climate](https://codeclimate.com/github/whitef0x0/Btorrent/badges/gpa.svg)](https://codeclimate.com/github/whitef0x0/Btorrent)
[![Deploy](https://www.herokucdn.com/deploy/button.png)](https://heroku.com/deploy)

**[βTorrent]** is a fully-featured **[WebTorrent]** browser client written in [Jade], [CoffeeScript] and [Sass]

### Features
- Informative GUI with easy sharing options
- Downloading from an info hash or magnet URI
- Seeding files (Single file only for the moment)
- Download/Upload speed per torrent
- Removing torrents from the client
- Client Debugging

### Built with
- [WebTorrent]
- [AngularJS]
- [Skeleton]
- [Normalize.css]
- [Moment.js]
- [pretty-bytes]

Website powered by [jsDelivr] and [CloudFlare]. I use [nginx] in my server.

### Easily built, tested and served
**I use [Harp] to rapidly test and compile the project**

Build the project into HTML, JS and CSS easily. Just use:
```bash
harp compile
```
This will create a www folder with the compiled files

If you need to serve the files and view the compiled version instantly just use:
```bash
harp server
```

### Enable Debugging
Enable βTorrent (Debug logging) and WebTorrent (Logs logging) debug logs by running this in the developer console:
```js
localStorage.debug = '*'
```
Disable by running this:
```js
localStorage.removeItem('debug')
```

### Help βTorrent
- **[Create a new issue](https://github.com/DiegoRBaquero/bTorrent/issues/new)** to report bugs or suggest new features
- **[Send a PR](https://github.com/DiegoRBaquero/BTorrent/pull/new/master)** with your changes

### License
MIT. Copyright (c) [Diego Rodríguez Baquero](http://diegorbaquero.com)

[βTorrent]: https://btorrent.xyz
[WebTorrent]: https://webtorrent.io
[AngularJS]: https://angularjs.org/
[Skeleton]: http://getskeleton.com/
[Normalize.css]: https://necolas.github.io/normalize.css/
[Moment.js]: http://momentjs.com/
[pretty-bytes]: https://github.com/sindresorhus/pretty-bytes
[Jade]: http://jade-lang.com/
[CoffeeScript]: http://coffeescript.org/
[Sass]: http://sass-lang.com/
[Harp]: http://harpjs.com/
[jsDelivr]: https://www.jsdelivr.com/
[CloudFlare]: https://www.cloudflare.com/
[nginx]: http://nginx.org/
