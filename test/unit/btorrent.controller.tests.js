(function () {
  // Articles Controller Spec
  describe('Btorrent Controller Tests', function () {
    // Initialize global variables
    var bTorrentCtrl,
      scope,
      $httpBackend,
      $stateParams,
      $location,
      WebTorrent

    // The $resource service augments the response object with methods for updating and deleting the resource.
    // If we were to use the standard toEqual matcher, our tests would fail because the test values would not match
    // the responses exactly. To solve the problem, we define a new toEqualData Jasmine matcher.
    // When the toEqualData matcher compares two objects, it takes only object properties into
    // account and ignores methods.
    beforeEach(function () {
      jasmine.addMatchers({
        toEqualData: function (util, customEqualityTesters) {
          return {
            compare: function (actual, expected) {
              return {
                pass: angular.equals(actual, expected)
              }
            }
          }
        }
      })
    })

    var newWebTorrent = function (torrent) {
			var result = {
				torrents: [],
				processing: false,
		    seed: function (item) {
		    },
		    add: function (item) {
		    }
			}
			return result
		}
		
    //Mock WebTorrent
  	//beforeEach(inject(function (WebTorrent) {
  		//var modal = newWebTorrent()
  	  //spyOn(WebTorrent, 'add').and.returnValue(newWebTorrent())
  	//}))

    // Load the main application module
    beforeEach(module('bTorrent'))

    // The injector ignores leading and trailing underscores here (i.e. _$httpBackend_).
    // This allows us to inject a service but then attach it to a variable
    // with the same name as the service.
    beforeEach(inject(function ($controller, $rootScope, _$location_, _$httpBackend_) {
      // Set a new global scope
      scope = $rootScope.$new()

      // Point global variables to injected services
      $httpBackend = _$httpBackend_
      $location = _$location_

      // Initialize the Articles controller.
      bTorrentCtrl = $controller('bTorrentCtrl', {
        $scope: scope
      })
      expect(scope.seedIt).toBe(true)
    }))

    describe('scope.done()', function () {
      beforeEach(function () {
        scope.client.torrents = [{
          fileName: 'torrent1.torrent',
          showFiles: false
        },
        {
          fileName: 'torrent2.torrent',
          showFiles: true
        },
        {
          fileName: 'torrent3.torrent',
          showFiles: false
        }]
      })

      it('scope.done() should return false if at least one torrent is not done', function () {
        // Run controller functionality
        var isDone = scope.client.done()

        // Test scope value
        expect(isDone).toBe(false)
      })

      it('scope.done() should return true if all torrents are done', function () {
        scope.client.torrents.map(function(torrent){
          torrent.done = true
          return torrent
        })

        // Run controller functionality
        var isDone = scope.client.done()

        // Test scope value
        expect(isDone).toBe(true)
      })
    })

    describe('scope.fromInput()', function() {
      beforeEach(function () {
        scope.client.torrents = [{
          fileName: 'torrent1.torrent',
          showFiles: false
        },
        {
          fileName: 'torrent2.torrent',
          showFiles: true
        },
        {
          fileName: 'torrent3.torrent',
          showFiles: false
        }]

        spyOn(scope.client, 'add').and.callFake(function(torrentMagnet, opts, cb){
          scope.client.torrents.push({
            magnetURI: torrentMagnet,
            showFiles: false,
            done: false
          })
        })
      })

      it('scope.fromInput() should not do anything if torrentInput is undefined', function () {
        expect(scope.torrentInput).not.toEqual(jasmine.anything())
        scope.client.processing = false
        // Run controller functionality
        scope.fromInput()

        // Test scope value
        expect(scope.client.processing).toBe(false)
        expect(scope.client.torrents.length).toBe(3)
      })

      it('scope.fromInput() should not do anything if torrentInput is an empty string', function () {
        scope.torrentInput = ''
        scope.client.processing = false
        // Run controller functionality
        scope.fromInput()

        // Test scope value
        expect(scope.client.processing).toBe(false)
        expect(scope.client.torrents.length).toBe(3)
      })

      it('scope.fromInput() should add torrent if torrentInput is not undefined or empty', function () {
        scope.torrentInput = 'magnet:?xt=urn:btih:BFE0F947FAF031D7A77E0F582365F0AB4E4E3323&dn=ubuntu+linux+toolbox+1000+commands+for+ubuntu+and+debian+power+users+2nd+edition+true+pdf+by+christopher+negus+pradyutvam2+cpul+wiley+pdf+latest&tr=udp%3A%2F%2F9.rarbg.com%3A2710%2Fannounce&tr=udp%3A%2F%2Fglotorrents.pw%3A6969%2Fannounce'
        scope.client.processing = false
        // Run controller functionality
        scope.fromInput()

        // Test scope value
        expect(scope.client.processing).toBe(true)
        expect(scope.client.torrents.length).toBe(4)
        expect(scope.client.torrents[3]).toEqualData({
          magnetURI: 'magnet:?xt=urn:btih:BFE0F947FAF031D7A77E0F582365F0AB4E4E3323&dn=ubuntu+linux+toolbox+1000+commands+for+ubuntu+and+debian+power+users+2nd+edition+true+pdf+by+christopher+negus+pradyutvam2+cpul+wiley+pdf+latest&tr=udp%3A%2F%2F9.rarbg.com%3A2710%2Fannounce&tr=udp%3A%2F%2Fglotorrents.pw%3A6969%2Fannounce',
          showFiles: false,
          done: false
        })
      })
    })

    it('scope.destroyedTorrent() should set scope.client.processing to false', function () {
      scope.client.processing = false
      // Run controller functionality
      scope.destroyedTorrent()

      // Test scope value
      expect(scope.client.processing).toBe(false)
    })

    describe('scope.toggleTorrent()', function () {
    	beforeEach(function () {
    		scope.client.torrents = [{
    			fileName: 'torrent1.torrent',
    			showFiles: false
    		},
    		{
    			fileName: 'torrent2.torrent',
    			showFiles: true
    		},
    		{
    			fileName: 'torrent3.torrent',
    			showFiles: false
    		}]
    	})

	    it('scope.toggleTorrent() should show a torrent if it is hidden', function () {
	      // Run controller functionality
	      scope.toggleTorrent(scope.client.torrents[2])

	      // Test scope value
	      expect(scope.client.torrents[2].showFiles).toBe(true)
	      expect(scope.client.torrents[1].showFiles).toBe(false)
	      expect(scope.client.torrents[0].showFiles).toBe(false)
	      expect(scope.sTorrent).toEqualData(scope.client.torrents[2])
	    })
	  })
  })
}())