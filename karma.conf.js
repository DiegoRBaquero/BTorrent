'use strict'

/**
 * Module dependencies.
 */

// Karma configuration
module.exports = function (karmaConfig) {

	karmaConfig.set({
		// Frameworks to use
		frameworks: ['jasmine'],
		// List of files / patterns to load in the browser
		files: ['node_modules/webtorrent/*min.js', 
				'node_modules/angular/*min.js',
				'node_modules/angular-mocks/angular-mocks.js', 
				'node_modules/ng-file-upload/dist/*min.js',
				'node_modules/webtorrent/*min.js',
				'node_modules/moment/moment.js',
				'www/*', 
				'test/*.js'],

		// Test results reporter to use
		// Possible values: 'dots', 'progress', 'junit', 'growl', 'coverage'
		reporters: ['progress'],

		// Web server port
		port: 9876,

		// Enable / disable colors in the output (reporters and logs)
		colors: true,

		// Level of logging
		// Possible values: karmaConfig.LOG_DISABLE || karmaConfig.LOG_ERROR || karmaConfig.LOG_WARN || karmaConfig.LOG_INFO || karmaConfig.LOG_DEBUG
		logLevel: karmaConfig.LOG_INFO,

		// Enable / disable watching file and executing tests whenever any file changes
		autoWatch: true,

		// Start these browsers, currently available:
		// - Chrome
		// - ChromeCanary
		// - Firefox
		// - Opera
		// - Safari (only Mac)
		// - PhantomJS2
		// - IE (only Windows)
		browsers: ['PhantomJS2'],

		// If browser does not capture in given timeout [ms], kill it
		captureTimeout: 60000,

		// Continuous Integration mode
		// If true, it capture browsers, run tests and exit
		singleRun: true
	})
}
