trackers = [
  [ 'wss://tracker.btorrent.xyz' ],
  [ 'wss://tracker.webtorrent.io' ]
]

store = lfChunkStore(2)

try
  #store.put(0, 'hi')
catch e
  console.error(e)

opts = {announce: trackers, store: lfChunkStore}

rtcConfig = {
  "iceServers":[
    {"url":"stun:23.21.150.121","urls":"stun:23.21.150.121"},
    {"url":"stun:stun.l.google.com:19302","urls":"stun:stun.l.google.com:19302"},
    {"url":"stun:stun1.l.google.com:19302","urls":"stun:stun1.l.google.com:19302"},
    {"url":"stun:stun2.l.google.com:19302","urls":"stun:stun2.l.google.com:19302"},
    {"url":"stun:stun3.l.google.com:19302","urls":"stun:stun3.l.google.com:19302"},
    {"url":"stun:stun4.l.google.com:19302","urls":"stun:stun4.l.google.com:19302"},
    {
      "url":"turn:global.turn.twilio.com:3478?transport=udp",
      "urls":"turn:global.turn.twilio.com:3478?transport=udp",
      "username":"857315a4616be37252127d4ff924c3a3536dd3fa729b56206dfa0e6808a80478",
      "credential":"EEEr7bxx8umMHC4sOoWDC/4MxU/4JCfL+W7KeSJEsBQ="
    },
    {
      "url": "turn:numb.viagenie.ca",
      "urls": "turn:numb.viagenie.ca",
      "credential": "webrtcdemo",
      "username": "louis%40mozilla.com"
    }
  ]
}

client = new WebTorrent {rtcConfig: rtcConfig}

dbg = (string, torrent, color) ->
  color = if color? then color else '#333333'
  if window.localStorage.getItem('debug')?
    if torrent? && torrent.name
      console.debug '%cβTorrent:torrent:' + torrent.name + ' (' + torrent.infoHash + ') %c' + string, 'color: #33C3F0', 'color: ' + color
      return
    else
      console.debug '%cβTorrent:client %c' + string, 'color: #33C3F0', 'color: ' + color
      return
  return

er = (err, torrent) ->
  dbg err, torrent, '#FF0000'

app = angular.module 'bTorrent', ['ui.grid', 'ui.grid.resizeColumns', 'ui.grid.selection', 'ngFileUpload', 'ngNotify'], ['$compileProvider','$locationProvider', ($compileProvider, $locationProvider) ->
  $compileProvider.aHrefSanitizationWhitelist /^\s*(https?|magnet|blob|javascript):/
  $locationProvider.html5Mode(
    enabled: true
    requireBase: false).hashPrefix '#'
]

app.controller 'bTorrentCtrl', ['$scope','$http','$log','$location', 'ngNotify', ($scope, $http, $log, $location, ngNotify) ->
  $scope.client = client
  $scope.seedIt = true
  $scope.client.validTorrents = []

  $scope.columns = [
    {field: 'name', cellTooltip: true, minWidth: '200'}
    {field: 'length', name: 'Size', cellFilter: 'pbytes', width: '80'}
    {field: 'received', displayName: 'Downloaded', cellFilter: 'pbytes', width: '135'}
    {field: 'downloadSpeed()', displayName: '↓ Speed', cellFilter: 'pbytes:1', width: '100'}
    {field: 'progress', displayName: 'Progress', cellFilter: 'progress', width: '100'}
    {field: 'timeRemaining', displayName: 'ETA', cellFilter: 'humanTime', width: '150'}
    {field: 'uploaded', displayName: 'Uploaded', cellFilter: 'pbytes', width: '125'}
    {field: 'uploadSpeed()', displayName: '↑ Speed', cellFilter: 'pbytes:1', width: '100'}
    {field: 'numPeers', displayName: 'Peers', width: '80'}
    {field: 'ratio', cellFilter: 'number:2', width: '80'}
  ]

  $scope.gridOptions =
    columnDefs: $scope.columns
    data: $scope.client.validTorrents
    enableColumnResizing: true
    enableColumnMenus: false
    enableRowSelection: true
    enableRowHeaderSelection: false
    multiSelect: false

  updateAll = ->
    if $scope.client.processing
      return
    $scope.$apply()
    return

  setInterval updateAll, 500

  $scope.gridOptions.onRegisterApi = ( gridApi ) ->
    $scope.gridApi = gridApi
    gridApi.selection.on.rowSelectionChanged $scope, (row) ->
      if !row.isSelected && $scope.selectedTorrent? && $scope.selectedTorrent.infoHash = row.entity.infoHash
        $scope.selectedTorrent = null
      else
        $scope.selectedTorrent = row.entity

  $scope.seedFile = (file) ->
    if file?
      dbg 'Seeding file ' + file.name
      $scope.client.processing = true
      $scope.client.seed file, opts, $scope.onSeed
    return

  $scope.openTorrentFile = (file) ->
    if file?
      dbg 'Adding torrent file ' + file.name
      $scope.client.processing = true
      $scope.client.add file, opts, $scope.onTorrent

  $scope.client.on('error', (err, torrent) ->
    $scope.client.processing = false
    ngNotify.set(err, 'error');
    er err, torrent
  )

  $scope.addMagnet = ->
    if $scope.torrentInput != ''
      dbg 'Adding magnet/hash ' + $scope.torrentInput
      $scope.client.processing = true
      $scope.client.add $scope.torrentInput, opts, $scope.onTorrent
      $scope.torrentInput = ''
      return

  $scope.destroyedTorrent = (err) ->
    $scope.client.processing = false
    if err
      throw err
    dbg 'Destroyed torrent'
    return

  $scope.onTorrent = (torrent, isSeed) ->
    dbg('Torrent metadata processed', torrent)
    torrent.safeTorrentFileURL = torrent.torrentFileURL
    torrent.fileName = torrent.name + '.torrent'

    if !isSeed
      $scope.client.validTorrents.push torrent
      if !($scope.selectedTorrent?)
        $scope.selectedTorrent = torrent
      $scope.client.processing = false

    torrent.files.forEach (file) ->
      file.getBlobURL (err, url) ->
        if err
          throw err
        if isSeed
          dbg 'Started seeding', torrent
          $scope.client.validTorrents.push torrent
          if !($scope.selectedTorrent?)
            $scope.selectedTorrent = torrent
          $scope.client.processing = false
        file.url = url
        if !isSeed
          dbg 'Finished downloading file ' + file.name, torrent
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
    return

  $scope.onSeed = (torrent) ->
    $scope.onTorrent torrent, true
    return

  if $location.hash() != ''
    $scope.client.processing = true
    setTimeout ->
      dbg 'Adding ' + $location.hash()
      $scope.client.add $location.hash(), opts, $scope.onTorrent
    , 500
    return
]

app.filter 'html', ['$sce', ($sce) ->
  (input) ->
    $sce.trustAsHtml input
    return
]

app.filter 'pbytes', ->
  (num, speed) ->
    if isNaN(num)
      return ''
    exponent = undefined
    unit = undefined
    units = [
      'B'
      'kB'
      'MB'
      'GB'
      'TB'
    ]
    if num < 1
      return (if speed then '' else '0 B')
    exponent = Math.min(Math.floor(Math.log(num) / Math.log(1000)), 8)
    num = (num / 1000 ** exponent).toFixed(1) * 1
    unit = units[exponent]
    num + ' ' + unit + (if speed then '/s' else '')

app.filter 'humanTime', ->
  (millis) ->
    if millis < 1000
      return ''
    remaining = moment.duration(millis / 1000, 'seconds').humanize()
    remaining[0].toUpperCase() + remaining.substr(1)

app.filter 'progress', ->
  (num) ->
    (100 * num).toFixed(1) + '%'
