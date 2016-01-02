trackers = [
  [ 'wss://tracker.btorrent.xyz' ]
  [ 'wss://tracker.webtorrent.io' ]
]

opts = {
  announce: trackers
}

rtcConfig = {
  "iceServers":[
    {"url":"stun:23.21.150.121","urls":"stun:23.21.150.121"}
    {"url":"stun:stun.l.google.com:19302","urls":"stun:stun.l.google.com:19302"}
    {
      "url":"turn:global.turn.twilio.com:3478?transport=udp"
      "urls":"turn:global.turn.twilio.com:3478?transport=udp"
      "username":"857315a4616be37252127d4ff924c3a3536dd3fa729b56206dfa0e6808a80478"
      "credential":"EEEr7bxx8umMHC4sOoWDC/4MxU/4JCfL+W7KeSJEsBQ="
    }
    {
      "url": "turn:numb.viagenie.ca"
      "urls": "turn:numb.viagenie.ca"
      "credential": "webrtcdemo"
      "username": "louis%40mozilla.com"
    }
  ]
}

debug = window.localStorage.getItem('debug')?

dbg = (string, item, color) ->
  color = if color? then color else '#333333'
  if debug
    if item? && item.name
      console.debug '%cβTorrent:' + (if item.infoHash? then 'torrent ' else 'torrent ' + item._torrent.name + ':file ') + item.name + (if item.infoHash? then ' (' + item.infoHash + ')' else '') + ' %c' + string, 'color: #33C3F0', 'color: ' + color
    else
      console.debug '%cβTorrent:client %c' + string, 'color: #33C3F0', 'color: ' + color

er = (err, item) ->
  dbg err, item, '#FF0000'

client = new WebTorrent {rtcConfig: rtcConfig}

app = angular.module 'BTorrent', ['ui.grid', 'ui.grid.resizeColumns', 'ui.grid.selection', 'ngFileUpload', 'ngNotify'], ['$compileProvider','$locationProvider', ($compileProvider, $locationProvider) ->
  $compileProvider.aHrefSanitizationWhitelist /^\s*(https?|magnet|blob|javascript):/
  $locationProvider.html5Mode(
    enabled: true
    requireBase: false
  ).hashPrefix '#'
]

app.controller 'BTorrentCtrl', ['$scope','$http','$log','$location', 'ngNotify', ($scope, $http, $log, $location, ngNotify) ->
  if !WebTorrent.WEBRTC_SUPPORT?
    $scope.disabled = true 
    ngNotify.set 'Please use latest Chrome, Firefox or Opera', {type: 'error', sticky: true, button: false}
  
  $scope.client = client
  $scope.seedIt = true

  $scope.columns = [
    {field: 'name', cellTooltip: true, minWidth: '200'}
    {field: 'length', name: 'Size', cellFilter: 'pbytes', width: '80'}
    {field: 'received', displayName: 'Downloaded', cellFilter: 'pbytes', width: '135'}
    {field: 'downloadSpeed()', displayName: '↓ Speed', cellFilter: 'pbytes:1', width: '100'}
    {field: 'progress', displayName: 'Progress', cellFilter: 'progress', width: '100'}
    {field: 'timeRemaining', displayName: 'ETA', cellFilter: 'humanTime', width: '140'}
    {field: 'uploaded', displayName: 'Uploaded', cellFilter: 'pbytes', width: '125'}
    {field: 'uploadSpeed()', displayName: '↑ Speed', cellFilter: 'pbytes:1', width: '100'}
    {field: 'numPeers', displayName: 'Peers', width: '80'}
    {field: 'ratio', cellFilter: 'number:2', width: '80'}
  ]

  $scope.gridOptions =
    columnDefs: $scope.columns
    data: $scope.client.torrents
    enableColumnResizing: true
    enableColumnMenus: false
    enableRowSelection: true
    enableRowHeaderSelection: false
    multiSelect: false

  updateAll = ->
    if $scope.client.processing
      return
    $scope.$apply()

  setInterval updateAll, 500

  $scope.gridOptions.onRegisterApi = (gridApi) ->
    $scope.gridApi = gridApi
    gridApi.selection.on.rowSelectionChanged $scope, (row) ->
      if !row.isSelected && $scope.selectedTorrent? && $scope.selectedTorrent.infoHash = row.entity.infoHash
        $scope.selectedTorrent = null
      else 
        $scope.selectedTorrent = row.entity

  $scope.seedFiles = (files) ->
    if files?
      if files.length == 1
        dbg 'Seeding file ' + files[0].name
      else
        dbg 'Seeding ' + files.length + ' files'
        name = prompt('Please name your torrent', 'My Awesome Torrent') || 'My Awesome Torrent'
        opts.name = name
      $scope.client.processing = true
      $scope.client.seed files, opts, $scope.onSeed
      delete opts.name

  $scope.openTorrentFile = (file) ->
    if file?
      dbg 'Adding torrent file ' + file.name 
      $scope.client.processing = true
      $scope.client.add file, opts, $scope.onTorrent

  $scope.client.on 'error', (err, torrent) ->
    $scope.client.processing = false
    ngNotify.set err, 'error'
    er err, torrent

  $scope.addMagnet = ->
    if $scope.torrentInput != ''
      dbg 'Adding magnet/hash ' + $scope.torrentInput
      $scope.client.processing = true
      $scope.client.add $scope.torrentInput, opts, $scope.onTorrent
      $scope.torrentInput = ''

  $scope.destroyedTorrent = (err) ->
    if err
      throw err
    dbg 'Destroyed torrent', $scope.selectedTorrent
    $scope.selectedTorrent = null
    $scope.client.processing = false

  $scope.changePriority = (file) ->
    if file.priority == '-1'
      dbg 'Deselected', file
      file.deselect()
    else
      dbg 'Selected ', file
      file.select()

  $scope.onTorrent = (torrent, isSeed) ->
    torrent.safeTorrentFileURL = torrent.torrentFileURL
    torrent.fileName = torrent.name + '.torrent'
    if !isSeed      
      if !($scope.selectedTorrent?)
        $scope.selectedTorrent = torrent
      $scope.client.processing = false
    torrent.files.forEach (file) ->
      file.getBlobURL (err, url) ->
        if err
          throw err
        if isSeed
          dbg 'Started seeding', torrent          
          if !($scope.selectedTorrent?)
            $scope.selectedTorrent = torrent
          $scope.client.processing = false
        file.url = url
        if !isSeed
          dbg 'Done ', file
      if !isSeed
        dbg 'Received metadata', file
    torrent.on 'download', (chunkSize) ->
      if !isSeed
        dbg 'Downloaded chunk', torrent
    torrent.on 'upload', (chunkSize) ->
      dbg 'Uploaded chunk', torrent
    torrent.on 'done', ->
      if !isSeed
        dbg 'Done', torrent
      torrent.update()
    torrent.on 'wire', (wire, addr) ->
      dbg 'Wire ' + addr, torrent
    torrent.on 'error', (err) ->
      er err

  $scope.onSeed = (torrent) ->
    $scope.onTorrent torrent, true

  if $location.hash() != ''
    $scope.client.processing = true
    setTimeout ->
      dbg 'Adding ' + $location.hash()      
      $scope.client.add $location.hash(), $scope.onTorrent
    , 0

  dbg 'Ready'
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
    units = [
      'B'
      'kB'
      'MB'
      'GB'
      'TB'
    ]
    if num < 1
      return (if speed then '' else '0 B')
    exponent = Math.min(Math.floor(Math.log(num) / 6.907755278982137), 8)
    num = (num / 1000 ** exponent).toFixed(1) * 1
    unit = units[exponent]
    num + ' ' + unit + (if speed then '/s' else '')

app.filter 'humanTime', ->
  (millis) ->
    if millis < 1000
      return ''
    remaining = moment.duration(millis).humanize()
    remaining[0].toUpperCase() + remaining.substr(1)

app.filter 'progress', ->
  (num) ->
    (100 * num).toFixed(1) + '%'