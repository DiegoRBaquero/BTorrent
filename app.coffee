trackers = [
  'wss://tracker.btorrent.xyz'
  'wss://tracker.webtorrent.io'
  'wss://tracker.openwebtorrent.com'
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
scope = null

app = angular.module 'BTorrent', ['ngRoute', 'ui.grid', 'ui.grid.resizeColumns', 'ui.grid.selection', 'ngFileUpload', 'ngNotify'], ['$compileProvider','$locationProvider', '$routeProvider', ($compileProvider, $locationProvider, $routeProvider) ->
  $compileProvider.aHrefSanitizationWhitelist /^\s*(https?|magnet|blob|javascript):/
  $locationProvider.html5Mode(
    enabled: true
    requireBase: false
  ).hashPrefix '#'
  
  $routeProvider.when '/stream',
    templateUrl: 'views/stream.html'
    controller: 'StreamCtrl'
  .when '/download',
    templateUrl: 'views/download.html'
    controller: 'DownloadCtrl'
  .otherwise 
    templateUrl: 'views/main.html'
    controller: 'MainCtrl'
]

app.controller 'BTorrentCtrl', ['$scope','$rootScope','$http','$log','$location', 'ngNotify', ($scope, $rootScope, $http, $log, $location, ngNotify) ->
  ngNotify.config
    duration: 10000
    html: true

  if !WebTorrent.WEBRTC_SUPPORT?
    $rootScope.disabled = true
    ngNotify.set 'Please use latest Chrome, Firefox or Opera', {type: 'error', sticky: true, button: false}

  $rootScope.client = client
  scope = $rootScope

  updateAll = ->
    if $rootScope.client.processing
      return
    $rootScope.$apply()

  setInterval updateAll, 500

  $rootScope.seedFiles = (files) ->
    if files?
      if files.length == 1
        dbg 'Seeding file ' + files[0].name
      else
        dbg 'Seeding ' + files.length + ' files'
        name = prompt('Please name your torrent', 'My Awesome Torrent') || 'My Awesome Torrent'
        opts.name = name
      $rootScope.client.processing = true
      $rootScope.client.seed files, opts, $rootScope.onSeed
      delete opts.name

  $rootScope.openTorrentFile = (file) ->
    if file?
      dbg 'Adding torrent file ' + file.name
      $rootScope.client.processing = true
      $rootScope.client.add file, opts, $rootScope.onTorrent

  $rootScope.client.on 'error', (err, torrent) ->
    $rootScope.client.processing = false
    ngNotify.set err, 'error'
    er err, torrent

  $rootScope.addMagnet = (magnet) ->
    if magnet? && magnet.length > 0
      dbg 'Adding magnet/hash ' + magnet
      $rootScope.client.processing = true
      $rootScope.client.add magnet, opts, $rootScope.onTorrent

  $rootScope.destroyedTorrent = (err) ->
    if err
      throw err
    dbg 'Destroyed torrent', $rootScope.selectedTorrent
    $rootScope.selectedTorrent = null
    $rootScope.client.processing = false

  $rootScope.changePriority = (file) ->
    if file.priority == '-1'
      dbg 'Deselected', file
      file.deselect()
    else
      dbg 'Selected with priority ' + file.priority, file
      file.select(file.priority)

  $rootScope.onTorrent = (torrent, isSeed) ->
    dbg torrent.magnetURI
    torrent.safeTorrentFileURL = torrent.torrentFileBlobURL
    torrent.fileName = torrent.name + '.torrent'
    if !isSeed
      if !($rootScope.selectedTorrent?)
        $rootScope.selectedTorrent = torrent
      $rootScope.client.processing = false
    torrent.files.forEach (file) ->
      file.getBlobURL (err, url) ->
        if err
          throw err
        if isSeed
          dbg 'Started seeding', torrent
          if !($rootScope.selectedTorrent?)
            $rootScope.selectedTorrent = torrent
          $rootScope.client.processing = false
        file.url = url
        if !isSeed
          dbg 'Done ', file
          ngNotify.set '<b>' + file.name + '</b> ready for download', 'success'
      if !isSeed
        dbg 'Received metadata', file
        ngNotify.set 'Received ' + torrent.name + ' metadata'
      console.info $rootScope.client
      console.info $rootScope.client
    torrent.on 'download', (chunkSize) ->
      #if !isSeed
      #  dbg 'Downloaded chunk', torrent
    torrent.on 'upload', (chunkSize) ->
      #dbg 'Uploaded chunk', torrent
    torrent.on 'done', ->
      if !isSeed
        dbg 'Done', torrent
      ngNotify.set '<b>' + torrent.name + '</b> has finished downloading', 'success'
    torrent.on 'wire', (wire, addr) ->
      dbg 'Wire ' + addr, torrent
    torrent.on 'error', (err) ->
      er err

  $rootScope.onSeed = (torrent) ->
    $rootScope.onTorrent torrent, true

  if $location.hash() != ''
    $rootScope.client.processing = true
    setTimeout ->
      dbg 'Adding ' + $location.hash()
      $rootScope.client.add $location.hash(), $rootScope.onTorrent
    , 0

  dbg 'Ready'
]

app.controller 'MainCtrl', ['$scope','$rootScope','$http','$log','$location', 'ngNotify', ($scope, $rootScope, $http, $log, $location, ngNotify) ->
  ngNotify.config
    duration: 10000
    html: true

  $scope.addMagnet = ->
    $rootScope.addMagnet($scope.torrentInput)
    $scope.torrentInput = ''
    
  $scope.columns = [
    {field: 'name', cellTooltip: true, minWidth: '200'}
    {field: 'length', name: 'Size', cellFilter: 'pbytes', width: '80'}
    {field: 'received', displayName: 'Downloaded', cellFilter: 'pbytes', width: '135'}
    {field: 'downloadSpeed', displayName: '↓ Speed', cellFilter: 'pbytes:1', width: '100'}
    {field: 'progress', displayName: 'Progress', cellFilter: 'progress', width: '100'}
    {field: 'timeRemaining', displayName: 'ETA', cellFilter: 'humanTime', width: '140'}
    {field: 'uploaded', displayName: 'Uploaded', cellFilter: 'pbytes', width: '125'}
    {field: 'uploadSpeed', displayName: '↑ Speed', cellFilter: 'pbytes:1', width: '100'}
    {field: 'numPeers', displayName: 'Peers', width: '80'}
    {field: 'ratio', cellFilter: 'number:2', width: '80'}
  ]

  $scope.gridOptions =
    columnDefs: $scope.columns
    data: $rootScope.client.torrents
    enableColumnResizing: true
    enableColumnMenus: false
    enableRowSelection: true
    enableRowHeaderSelection: false
    multiSelect: false

  $scope.gridOptions.onRegisterApi = (gridApi) ->
    $scope.gridApi = gridApi
    gridApi.selection.on.rowSelectionChanged $scope, (row) ->
      if !row.isSelected && $rootScope.selectedTorrent? && $rootScope.selectedTorrent.infoHash = row.entity.infoHash
        $rootScope.selectedTorrent = null
      else 
        $rootScope.selectedTorrent = row.entity
]

app.controller 'DownloadCtrl', ['$scope','$rootScope','$http','$log','$location', 'ngNotify', ($scope, $rootScope, $http, $log, $location, ngNotify) ->
  ngNotify.config
    duration: 10000
    html: true

  $scope.addMagnet = ->
    $rootScope.addMagnet($scope.torrentInput)
    $scope.torrentInput = ''
]

app.controller 'StreamCtrl', ['$scope','$rootScope','$http','$log','$location', 'ngNotify', ($scope, $rootScope, $http, $log, $location, ngNotify) ->
  ngNotify.config
    duration: 10000
    html: true

  $scope.addMagnet = ->
    $rootScope.addMagnet($scope.torrentInput)
    $scope.torrentInput = ''
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
