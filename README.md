βTorrent
========
**[βTorrent]** is a fully-featured **[WebTorrent]** browser client written in HTML, JS and CSS

[![Join the chat at https://gitter.im/DiegoRBaquero/BTorrent](https://badges.gitter.im/DiegoRBaquero/BTorrent.svg)](https://gitter.im/DiegoRBaquero/BTorrent?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge&utm_content=badge)

### Features
- [x] Informative GUI with easy sharing options
- [x] Downloading from an info hash or magnet URI
- [x] Downloading from a .torrent file (Coming Soon)
- [x] Seeding files (Single/multiple files)
- [ ] Seeding CORS-enabled remote files (Coming Soon) 
- [x] Download/Upload speed per torrent
- [x] Download/Upload speed of client (All torrents)
- [x] Removing torrents from the client
- [x] Pause/Resume torrent
- [x] Selecting/Deselecting files (Coming Soon)
- [x] Client Debugging
- [ ] Use custom trackers/rtcConfig

### Built with
- [WebTorrent]
- [AngularJS]
- [Skeleton]
- [Normalize.css]
- [Moment.js]
- [ui-grid]
- [pretty-bytes]
- [ng-file-upload]
- [ng-notify]

Website powered by [jsDelivr] and [CloudFlare]. I use [nginx] in my server.

### HTML5 serving
**You must serve index.html as the default**

For nginx, use this conf:
```
    location / {
        try_files $uri$args $uri$args/ /index.html;
    }
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
MIT. Copyright (c) [Diego Rodríguez Baquero](https://diegorbaquero.com)

[βTorrent]: https://btorrent.xyz
[WebTorrent]: https://webtorrent.io
[AngularJS]: https://angularjs.org/
[Skeleton]: http://getskeleton.com/
[Normalize.css]: https://necolas.github.io/normalize.css/
[Moment.js]: http://momentjs.com/
[ui-grid]: http://ui-grid.info/
[pretty-bytes]: https://github.com/sindresorhus/pretty-bytes
[ng-file-upload]: https://github.com/danialfarid/ng-file-upload
[ng-notify]: https://github.com/matowens/ng-notify
[Jade]: http://jade-lang.com/
[CoffeeScript]: http://coffeescript.org/
[Sass]: http://sass-lang.com/
[Harp]: http://harpjs.com/
[jsDelivr]: https://www.jsdelivr.com/
[CloudFlare]: https://www.cloudflare.com/
[nginx]: http://nginx.org/
