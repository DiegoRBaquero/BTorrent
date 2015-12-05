trackers = [
	[ 'udp://tracker.openbittorrent.com:80' ],
	[ 'udp://tracker.internetwarriors.net:1337' ],
	[ 'udp://tracker.leechers-paradise.org:6969' ],
	[ 'udp://tracker.coppersurfer.tk:6969' ],
	[ 'udp://exodus.desync.com:6969' ],
	[ 'udp://9.rarbg.com:2710/announce' ],
	[ 'udp://tracker.publicbt.com:80/announce' ],
	[ 'udp://coppersurfer.tk:6969/announce' ],
	[ 'udp://tracker4.piratux.com:6969/announce' ],
	[ 'udp://open.demonii.com:1337/announce' ],
	[ 'udp://glotorrents.pw:6969/announce' ],
	[ 'wss://tracker.webtorrent.io' ],
	[ 'wss://tracker.btorrent.xyz' ]
]

opts = {announce: trackers}

client = new WebTorrent().on('error', (err) -> 
	console.error err
).on('torrent', (torrent) ->
	console.log('torrent is ready')
)
debug = window.localStorage ? window.localStorage.getItem('debug') == '*':false

app = angular.module 'bTorrent', ['ngFileUpload','ui.bootstrap'], ['$compileProvider','$locationProvider', ($compileProvider, $locationProvider) ->
	$compileProvider.aHrefSanitizationWhitelist /^\s*(https?|magnet|blob|javascript):/
	$locationProvider.html5Mode(
		enabled: true
		requireBase: false).hashPrefix '#'
]

# let's make a modal called `myModal`
app.controller 'ModalCtrl', ['$scope', ($scope) ->
	console.log('hello')
]

app.controller 'bTorrentCtrl', ['Upload','$uibModal','$scope','$http','$log','$location', (Upload, $uibModal, $scope, $http, $log, $location) ->
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

	$scope.uploadSeed = (file) ->
		$scope.client.processing = true
		dbg 'Seeding ' + file.name
		$scope.client.seed file, opts, $scope.onSeed
		return

	$scope.openCreateModal = () ->
		modalInstance = $uibModal.open(
			animation: true
			templateUrl: 'create-modal.html'
		)
		modalInstance.result.then ((selectedItem)->
			$scope.selected = selectedItem
			return
		), ->
			$log.info 'Modal dismissed at: ' + new Date
			return
	$scope.uploadTorrent = (file) ->
		$scope.client.processing = true
		dbg('Adding ') + file.name
		$scope.client.add file, opts, $scope.onTorrent
		$scope.magnetLinkInput = ''
		return

	$scope.addByMagnet = () ->
		if $scope.magnetLinkInput && $scope.magnetLinkInput.length
			$scope.client.processing = true
			$scope.magnetLinkInput += ''

			dbg('Adding magnetLinkInput: ' + $scope.magnetLinkInput)
			$scope.client.add($scope.magnetLinkInput, opts, $scope.onTorrent)

			$scope.magnetLinkInput = ''
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

	$scope.pauseTorrent = (torrent) ->
		if !torrent.destroyed && !torrent.done && !torrent.paused
			torrent.pause()
			return

	$scope.resumeTorrent = (torrent) ->
		if !torrent.destroyed && !torrent.done && torrent.paused
			torrent.resume()
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

		dbg 'onTorrent'
		torrent.update = ->
			if this.pieces
				torrent.pProgress = (100 * torrent.progress).toFixed(1)
				if torrent.done
					torrent.tRemaining = 'Done'
					return
				else
					remaining = moment.duration(torrent.timeRemaining / 1000, 'seconds').humanize()
					torrent.tRemaining = remaining[0].toUpperCase() + remaining.substr(1)
					return
			else 
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
