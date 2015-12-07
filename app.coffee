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

dbg = (string, torrent) ->
  if window.localStorage.getItem('debug')?
    if torrent
      console.debug '%c' + torrent.name + ' (' + torrent.infoHash + '): %c' + string, 'color: #33C3F0', 'color: #333'
      return
    else
      console.debug '%cClient: %c' + string, 'color: #33C3F0', 'color: #333'
      return
  return

app = angular.module 'bTorrent', ['ui.grid', 'ui.grid.resizeColumns', 'ui.grid.selection', 'ngFileUpload'], ['$compileProvider','$locationProvider', ($compileProvider, $locationProvider) ->
  $compileProvider.aHrefSanitizationWhitelist /^\s*(https?|magnet|blob|javascript):/
  $locationProvider.html5Mode(
    enabled: true
    requireBase: false).hashPrefix '#'
]

app.controller 'bTorrentCtrl', ['$scope','$http','$log','$location', 'uiGridConstants', ($scope, $http, $log, $location, uiGridConstants) ->
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
      dbg 'Seeding ' + file.name
      $scope.client.processing = true
      $scope.client.seed file, opts, $scope.onSeed
    return
    
  $scope.openTorrentFile = (file) ->
    if file?
      dbg 'Adding ' + file.name 
      $scope.client.processing = true
      url = URL.createObjectURL file 
      $http.get(url).then((response) ->
        dbg 'Success' + response.data
      , (response) ->
        dbg 'ERROR'
      )
      $scope.client.add url, opts, $scope.onTorrent

  $scope.addMagnet = ->
    if $scope.torrentInput != ''
      dbg 'Adding ' + $scope.torrentInput
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
    $scope.client.validTorrents.push torrent
    torrent.safeTorrentFileURL = torrent.torrentFileURL
    torrent.fileName = torrent.name + '.torrent'
    
    if !isSeed
      $scope.client.processing = false    
    if !($scope.selectedTorrent?) || isSeed
      $scope.selectedTorrent = torrent

    torrent.files.forEach (file) ->
      file.getBlobURL (err, url) ->
        if err
          throw err
        if isSeed
          dbg 'Started seeding', torrent
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
      $scope.client.add $location.hash(), $scope.onTorrent
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