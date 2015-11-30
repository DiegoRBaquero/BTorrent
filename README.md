βTorrent
========

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
**I use [Harp] to rapidly test the proyect and also to compile it**

Build the proyect into HTML, JS and CSS easily. Just use:
```bash
harp compile
```
This will create a www folder with the compiled files

If you need to serve the files and view the compiled version instantly just use:
```bash
harp server
```

### Enable Debugging
Enable debug logs by running this in the developer console:
```js
debug = true
```
Enable WebTorrent and its submodules debug logs by running this in the developer console:
```js
localStorage.debug = '*'
```

### Help βTorrent
- **[Create a new issue](https://github.com/DiegoRBaquero/bTorrent/issues/new)** to report bugs or suggest new features

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
