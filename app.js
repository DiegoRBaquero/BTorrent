var client = new WebTorrent({
    rtcConfig: {
        "iceServers": [{
            "url": "stun:23.21.150.121",
            "urls": "stun:23.21.150.121"
        }, {
            "url": "turn:global.turn.twilio.com:3478?transport=udp",
            "username": "00bb844e6c2a07d4ed3e22a6edd6da6a715714a7c3eb118dc20246e5e0cc50c1",
            "credential": "Wv1IxOBVhm4CGqoWYQWQ0X4Ia0Va7p2SOENv/S7M9Vg=",
            "urls": "turn:global.turn.twilio.com:3478?transport=udp"
        }]
    }
});
var debug = true;

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
    num = (num / Math.pow(1000, exponent)).toFixed(1) * 1;
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
    $scope.client = client;
    $scope.seedIt = true;

    var dbg = function (string, torrent) {
        if (debug) {
            if (torrent)
                $log.debug("%c" + torrent.name + " (" + torrent.infoHash + "): %c" + string, 'color: #33C3F0', 'color: #333');
            else
                $log.debug("%cClient: %c" + string, 'color: #33C3F0', 'color: #333');
        }
    };

    var updateAll = function () {
        $scope.$apply();
    };

    setInterval(updateAll, 500);

    $scope.client.done = function () {
        var done = true;
        $scope.client.torrents.forEach(function (torrent) {
            if (!torrent.done) {
                done = false;
            }
        });
        return done;
    };

    $scope.client.downloading = function () {
        var downloading = true;
        $scope.client.torrents.forEach(function (torrent) {
            if (torrent.done) {
                downloading = false;
            }
        });
        return downloading;
    };

    $scope.uploadFile = function () {
        document.getElementById("fileUpload").click();
    };
    $scope.uploadFile2 = function (elem) {
        $scope.client.processing = true;
        dbg("Seeding " + elem.files[0].name);
        $scope.client.seed(elem.files, $scope.onSeed);
    };

    $scope.fromInput = function () {
        if (!$scope.torrentInput == "") {
            $scope.client.processing = true;
            dbg("Adding " + $scope.torrentInput);
            $scope.client.add($scope.torrentInput, $scope.onTorrent);
            $scope.torrentInput = "";
        }
    };

    $scope.toggleTorrent = function (torrent) {
        if (torrent.showFiles) {
            torrent.showFiles = false;
            $scope.sTorrent = null;
        } else {
            $scope.client.torrents.forEach(function (t) {
                t.showFiles = false;
            });
            torrent.showFiles = true;
            $scope.sTorrent = torrent;
        }
    };

    $scope.destroyedTorrent = function (err) {
        if (err) throw err;
        dbg("Destroyed torrent");
    };

    $scope.onTorrent = function (torrent, isSeed) {
        $scope.client.processing = false;
        torrent.showFiles = false;
        torrent.pSize = prettyBytes(torrent.length);
        torrent.fileName = torrent.name + '.torrent';
        torrent.oTorrentFileURL = torrent.torrentFileURL;

        if (angular.isUndefined($scope.sTorrent) || $scope.sTorrent === null) {
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

        torrent.files.forEach(function (file) {
            file.pSize = prettyBytes(file.length);
            file.status = "Downloading";
            file.url = 'javascript: return false;';
            file.getBlobURL(function (err, url) {
                if (err) throw err;
                file.url = url;
                if(!isSeed) dbg("Finished downloading file " + file.name, torrent);
                file.status = "Ready";
                $scope.$apply();
            });
            if(!isSeed) dbg("Received file " + file.name + " metadata", torrent);
        });

        torrent.on('download', function (chunkSize) {
            if(!isSeed) dbg("Downloaded chunk", torrent);
        });

        torrent.on('upload', function (chunkSize) {
            dbg("Uploaded chunk", torrent);
        });

        torrent.on('done', function () {
            if(!isSeed) dbg("Done", torrent);
            torrent.update();
        });

        torrent.on('wire', function (wire, addr) {
            dbg("Wire " + addr, torrent);
        });

        setInterval(torrent.update, 500);
        torrent.update();
    };

    $scope.onSeed = function(torrent) {
        $scope.onTorrent(torrent, true);
    };

    if ($location.hash() != '') {
        $scope.client.processing = true;
        dbg("Adding " + $location.hash());
        client.add($location.hash(), $scope.onTorrent);
    }
}).filter('html', function ($sce) {
    return function (input) {
        return $sce.trustAsHtml(input);
    }
});