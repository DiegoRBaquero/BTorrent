var client = new WebTorrent({rtcConfig: {"iceServers":[{"url":"stun:23.21.150.121","urls":"stun:23.21.150.121"},{"url":"turn:global.turn.twilio.com:3478?transport=udp","username":"00bb844e6c2a07d4ed3e22a6edd6da6a715714a7c3eb118dc20246e5e0cc50c1","credential":"Wv1IxOBVhm4CGqoWYQWQ0X4Ia0Va7p2SOENv/S7M9Vg=","urls":"turn:global.turn.twilio.com:3478?transport=udp"}]}});
var DEBUG = true;

var prettyBytes = function (num) {
    var exponent;
    var unit;
    var neg = num < 0;
    var units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

    if (neg) {
        num = -num;
    }

    if (num < 1) {
        return (neg ? '-' : '') + num + ' B';
    }

    exponent = Math.min(Math.floor(Math.log(num) / Math.log(1000)), units.length - 1);
    num = (num / Math.pow(1000, exponent)).toFixed(2) * 1;
    unit = units[exponent];

    return (neg ? '-' : '') + num + ' ' + unit;
};

angular.module('bTorrent', [], function ($compileProvider, $locationProvider) {
    $compileProvider.aHrefSanitizationWhitelist(/^\s*(https?|magnet|blob|javascript):/);
    $locationProvider.html5Mode({
        enabled: true,
        requireBase: false
    }).hashPrefix('#');
}).controller('bTorrentCtrl', function ($scope, $http, $log, $location) {
    if(DEBUG) $log.debug($location.hash());
    $scope.client = client;
    $scope.seedIt = true;

    $scope.updateAll = function() {
        $scope.$apply();
    };

    setInterval($scope.updateAll, 500);

    $scope.client.done = function() {
        var done = true;
        $scope.client.torrents.forEach(function(torrent) {
            if(!torrent.done) {
                done = false;
            }
        });
        return done;
    };

    $scope.client.downloading = function() {
        var downloading = true;
        $scope.client.torrents.forEach(function(torrent) {
            if(torrent.done) {
                downloading = false;
            }
        });
        return downloading;
    };

    $scope.uploadFile = function() {
        document.getElementById("fileUpload").click();
    };
    $scope.uploadFile2 = function(elem) {
        $scope.client.processing = true;
        $scope.client.seed(elem.files, $scope.onSeed);
    };

    $scope.fromInput = function() {
        if(!$scope.torrentInput == "") {
            $scope.client.processing = true;
            $scope.client.add($scope.torrentInput, $scope.onTorrent);
            $scope.torrentInput = "";
        }
    };

    $scope.toggleTorrent = function(torrent) {
        if(torrent.showFiles) {
            torrent.showFiles = false;
            $scope.sTorrent = null;
        } else {
            $scope.client.torrents.forEach(function(t) {
                t.showFiles = false;
            });
            torrent.showFiles = true;
            $scope.sTorrent = torrent;
        }
    };

    $scope.onSeed = function(torrent) {
        if($scope.seedIt) {
            if(DEBUG) $log.debug("Seed it");
            $http.get("seedIt.php?hash=" + torrent.infoHash).then(function(response) {
                if(DEBUG) $log.debug("Sent to seeder!");
            }, function(response) {
                if(DEBUG) $log.debug("Error sending to seeder!");
            });
        }
        $scope.onTorrent(torrent);
    };

    $scope.onTorrent = function(torrent) {
        $scope.client.processing = false;
        torrent.showFiles = false;
        torrent.pSize = prettyBytes(torrent.length);
        torrent.fileName = torrent.name + '.torrent';
        torrent.oTorrentFileURL = torrent.torrentFileURL;

        if(angular.isUndefined($scope.sTorrent) || $scope.sTorrent === null) {
            $scope.sTorrent = torrent;
            torrent.showFiles = true;
        }

        torrent.update = function () {
            torrent.pProgress = (100 * torrent.progress).toFixed(1);
            torrent.pDownloaded = prettyBytes(torrent.downloaded);
            torrent.pUploaded = prettyBytes(torrent.uploaded);
            torrent.pUploadSpeed = prettyBytes(torrent.uploadSpeed());
            torrent.pDownloadSpeed = prettyBytes(torrent.downloadSpeed());
            if (torrent.done) {
                torrent.tRemaining = 'Done'
            } else {
                var remaining = moment.duration(torrent.timeRemaining / 1000, 'seconds').humanize();
                torrent.tRemaining = remaining[0].toUpperCase() + remaining.substr(1);
            }
        };

        if(DEBUG) $log.debug("Downloading..." + torrent.infoHash);

        torrent.files.forEach(function (file) {
            file.pSize = prettyBytes(file.length);
            file.status = "Downloading";
            file.url = 'javascript: return false;';
            file.getBlobURL(function (err, url) {
                if (err) throw err;
                file.url = url;
                if(DEBUG) $log.debug("Got BLOB " + file.url);
                file.status = "Ready";
                $scope.$apply();
            });
            if(DEBUG) $log.debug("FILE");
        });

        torrent.on('download', function (chunkSize) {
            if(DEBUG) $log.debug("DOWNLOAD");
            torrent.update();
        });

        torrent.on('upload', function (chunkSize) {
            if(DEBUG) $log.debug("UPLOAD");
            torrent.update();
        });

        torrent.on('done', function () {
            if(DEBUG) $log.debug("DONE");
            torrent.update();
        });

        torrent.on('wire', function (wire, addr) {
            if(DEBUG) $log.debug("WIRE");
        });

        torrent.on('wire', function (wire, addr) {
            console.log('connected to peer with address ' + addr);
        });

        setInterval(torrent.update, 500);
        torrent.update();
    };

    if($location.hash() != '') {
        $scope.client.processing = true;
        client.add($location.hash(), $scope.onTorrent);
    }
}).filter('html', function ($sce) {
    return function (input) {
        return $sce.trustAsHtml(input);
    }
});