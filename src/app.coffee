trackers = [
  [ 'udp://tracker.openbittorrent.com:80' ],
  [ 'udp://tracker.internetwarriors.net:1337' ],
  [ 'udp://tracker.leechers-paradise.org:6969' ],
  [ 'udp://tracker.coppersurfer.tk:6969' ],
  [ 'udp://exodus.desync.com:6969' ],
  [ 'wss://tracker.webtorrent.io' ],
  [ 'wss://tracker.btorrent.xyz' ]
]

opts = {announce: trackers}

client = new WebTorrent
debug = window.localStorage ? window.localStorage.getItem('debug') == '*':false

app = angular.module 'bTorrent', [], ['$compileProvider','$locationProvider', ($compileProvider, $locationProvider) ->
  $compileProvider.aHrefSanitizationWhitelist /^\s*(https?|magnet|blob|javascript):/
  $locationProvider.html5Mode(
    enabled: true
    requireBase: false).hashPrefix '#'
]

app.controller 'bTorrentCtrl', ['$scope','$http','$log','$location', ($scope, $http, $log, $location) ->
  $scope.client = client
  $scope.seedIt = true

  dbg = (string, torrent) ->
    if debug
      if torrent
        $log.debug '%c' + torrent.name + ' (' + torrent.infoHash + '): %c' + string, 'color: #33C3F0', 'color: #333'
        return
      else
        $log.debug '%cClient: %c' + string, 'color: #33C3F0', 'color: #333'
        return
    return

  updateAll = ->
    $scope.$apply()
    return

  setInterval updateAll, 500

  $scope.client.done = ->
    done = true
    $scope.client.torrents.forEach (torrent) ->
      if !torrent.done
        done = false
        return
    done

  $scope.client.downloading = ->
    downloading = true
    $scope.client.torrents.forEach (torrent) ->
      if torrent.done
        downloading = false
        return
    downloading

  $scope.uploadFile = ->
    document.getElementById('fileUpload').click()
    return

  $scope.uploadFile2 = (elem) ->
    $scope.client.processing = true
    dbg 'Seeding ' + elem.files[0].name
    $scope.client.seed elem.files, opts, $scope.onSeed
    return

  $scope.fromInput = ->
    if $scope.torrentInput && $scope.torrentInput.length
      $scope.client.processing = true
      dbg('Adding ') + $scope.torrentInput
      $scope.client.add $scope.torrentInput, opts, $scope.onTorrent
      $scope.torrentInput = ''
      return

  $scope.toggleTorrent = (torrent) ->
    if torrent.showFiles
      torrent.showFiles = false
      $scope.sTorrent = null
      return
    else
      $scope.client.torrents.forEach (t) ->
        t.showFiles = false
      torrent.showFiles = true
      $scope.sTorrent = torrent
      return

  $scope.destroyedTorrent = (err) ->
    $scope.client.processing = false
    if err
      throw err
    dbg 'Destroyed torrent'
    return

  $scope.onTorrent = (torrent, isSeed) ->
    if !isSeed
      $scope.client.processing = false
    torrent.pSize = torrent.length
    torrent.showFiles = false
    torrent.fileName = torrent.name + '.torrent'
    torrent.oTorrentFileURL = torrent.torrentFileURL
    if angular.isUndefined($scope.sTorrent) or $scope.sTorrent == null
      $scope.sTorrent = torrent
      torrent.showFiles = true

    torrent.update = ->
      torrent.pProgress = (100 * torrent.progress).toFixed(1)
      if torrent.done
        torrent.tRemaining = 'Done'
        return
      else
        remaining = moment.duration(torrent.timeRemaining / 1000, 'seconds').humanize()
        torrent.tRemaining = remaining[0].toUpperCase() + remaining.substr(1)
        return

    torrent.files.forEach (file) ->
      file.pSize = file.length
      file.status = 'Downloading'
      file.url = 'javascript: return false;'
      file.getBlobURL (err, url) ->
        if err
          throw err
        if isSeed
          $scope.client.processing = false
        file.url = url
        if !isSeed
          dbg 'Finished downloading file ' + file.name, torrent
        file.status = 'Ready'
        return
      if !isSeed
        dbg 'Received file ' + file.name + ' metadata', torrent
        return
    torrent.on 'download', (chunkSize) ->
      if !isSeed
        dbg 'Downloaded chunk', torrent
        return
    torrent.on 'upload', (chunkSize) ->
      dbg 'Uploaded chunk', torrent
      return
    torrent.on 'done', ->
      if !isSeed
        dbg 'Done', torrent
        return
      torrent.update()
      return
    torrent.on 'wire', (wire, addr) ->
      dbg 'Wire ' + addr, torrent
      return
    setInterval torrent.update, 500
    torrent.update()
    return
  $scope.onSeed = (torrent) ->
    $scope.onTorrent torrent, true
    return

  if $location.hash() != ''
    $scope.client.processing = true
    dbg 'Adding ' + $location.hash()
    client.add $location.hash(), $scope.onTorrent
    return
]

app.filter 'html', ['$sce', ($sce) ->
  (input) ->
    $sce.trustAsHtml input
    return
]

app.filter 'pbytes', ->
  (num) ->
    if isNaN(num)
      return ''
    exponent = undefined
    unit = undefined
    neg = num < 0
    units = [
      'B'
      'kB'
      'MB'
      'GB'
      'TB'
      'PB'
      'EB'
      'ZB'
      'YB'
    ]
    if neg
      num = -num
    if num < 1
      return (if neg then '-' else '') + num + ' B'
    exponent = Math.min(Math.floor(Math.log(num) / Math.log(1000)), 8)
    num = (num / 1000 ** exponent).toFixed(1) * 1
    unit = units[exponent]
    (if neg then '-' else '') + num + ' ' + unit
