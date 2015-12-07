βTorrent
========

**[βTorrent]** is a fully-featured **[WebTorrent]** browser client written in [Jade], [CoffeeScript] and [Sass]

### Features
- [x] Informative GUI with easy sharing options
- [x] Downloading from an info hash or magnet URI
- [ ] Downloading from a .torrent file (Coming Soon)
- [x] Seeding files (Single file only for the moment)
- [ ] Seeding CORS-enabled remote files (Coming Soon) 
- [x] Download/Upload speed per torrent
- [ ] Download/Upload speed of client (All torrents)
- [ ] Removing torrents from the client (Coming Soon)
- [ ] Pause torrent (Coming Soon)
- [ ] Selecting/Deselecting files (Coming Soon)
- [x] Client Debugging

### Built with
- [WebTorrent]
- [AngularJS]
- [Skeleton]
- [Normalize.css]
- [Moment.js]
- [ui-grid]
- [pretty-bytes]
- [ng-file-upload]

Website powered by [jsDelivr] and [CloudFlare]. I use [nginx] in my server.

Don't like CloudFlare? No problem! Check [Direct-βTorrent]

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

### Thanks
- [jasalo](https://github.com/jasalo) For the logo and favicon
- [whitef0x0](https://github.com/whitef0x0) For cleanup and ng-file-upload and other ideas

### License
MIT. Copyright (c) [Diego Rodríguez Baquero](http://diegorbaquero.com)

[βTorrent]: https://btorrent.xyz
[Direct-βTorrent]: https://direct.btorrent.xyz
[WebTorrent]: https://webtorrent.io
[AngularJS]: https://angularjs.org/
[Skeleton]: http://getskeleton.com/
[Normalize.css]: https://necolas.github.io/normalize.css/
[Moment.js]: http://momentjs.com/
[ui-grid]: http://ui-grid.info/
[pretty-bytes]: https://github.com/sindresorhus/pretty-bytes
[ng-file-upload]: https://github.com/danialfarid/ng-file-upload
[Jade]: http://jade-lang.com/
[CoffeeScript]: http://coffeescript.org/
[Sass]: http://sass-lang.com/
[Harp]: http://harpjs.com/
[jsDelivr]: https://www.jsdelivr.com/
[CloudFlare]: https://www.cloudflare.com/
[nginx]: http://nginx.org/
