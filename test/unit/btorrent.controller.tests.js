'use strict'

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


    beforeEach(module('templates'))
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
				processing: false
			    seed: function ( item ) {
			        then: function (confirmCallback, cancelCallback) {
			            //Store the callbacks for later when the user clicks on the OK or Cancel button of the dialog
			            this.confirmCallBack = confirmCallback
			            this.cancelCallback = cancelCallback
			        }
			    },
			    add: function ( item ) {
			        //The user clicked OK on the modal dialog, call the stored confirm callback with the selected item
			        this.opened = false
			        this.result.confirmCallBack( item )
			    }
			}
			return result
		}
		

  //Mock WebTorrent
	beforeEach(inject(function (WebTorrent) {
		//var modal = newFakeModal()
	  //spyOn(WebTorrent, 'add').and.returnValue(newFakeModal())
	  //spyOn($uibModal, 'close').and.callFake(modal.close())
	}))


    // The injector ignores leading and trailing underscores here (i.e. _$httpBackend_).
    // This allows us to inject a service but then attach it to a variable
    // with the same name as the service.
    beforeEach(inject(function ($controller, $rootScope, _$location_, _$stateParams_, _$httpBackend_) {
      // Set a new global scope
      scope = $rootScope.$new()

      // Point global variables to injected services
      $stateParams = _$stateParams_
      $httpBackend = _$httpBackend_
      $location = _$location_

      // Initialize the Articles controller.
      bTorrentCtrl = $controller('bTorrentCtrl', {
        $scope: scope
      })
      expect($scope.seedIt).toBe(true)
    }))

    it('$scope.done() should return false if there are no torrents', inject(function () {
      // Run controller functionality
      var isDone = $scope.client.done()

      // Test scope value
      expect(isDone).toBe(false)
    }))

    it('$scope.fromInput() should not do anything if there are no torrents', inject(function () {
      // Run controller functionality
      $scope.client.fromInput()

      // Test scope value
      expect($scope.client.processing).toBe(false)
    }))

    describe('$scope.toggleTorrent', function () {
    	beforeEach(function () {
    		$scope.client.torrents = [{
    			fileName = 'torrent1.torrent',
    			showFiles = false
    		},
    		{
    			fileName = 'torrent2.torrent',
    			showFiles = true
    		},
    		{
    			fileName = 'torrent3.torrent',
    			showFiles = false
    		}]
    	})

	    it('$scope.toggleTorrent() should show a torrent if it is hidden', inject(function () {

	      // Run controller functionality
	      $scope.toggleTorrent($scope.clients.torrents[2])

	      // Test scope value
	      expect($scope.client.torrents[2].showFiles).toBe(true)
	      expect($scope.client.torrents[1].showFiles).toBe(false)
	      expect($scope.client.torrents[0].showFiles).toBe(false)
	      expect($scope.sTorrent).toEqualData($scope.client.torrents[2])
	    }))
	  })
  })
}())