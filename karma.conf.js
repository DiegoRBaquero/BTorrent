'use strict';

/**
 * Module dependencies.
 */
var karmaReporters = ['progress', 'mocha', 'html', 'coverage'];

// Karma configuration
module.exports = function (karmaConfig) {
	karmaConfig.set({
		// Frameworks to use
		frameworks: ['jasmine'],

		preprocessors: {
			'test/**/*.js': ['coverage'],
			'www/**.html': ['ng-html2js']
		},

	ngHtml2JsPreprocessor: {
			stripPrefix: 'www/',

			// the name of the Angular module to create
			moduleName: 'templates'
		},

		// List of files / patterns to load in the browser
		files: ['www/**.html', 'www/**.js', 'www/**.css'],

		// Test results reporter to use
		// Possible values: 'dots', 'progress', 'junit', 'growl', 'coverage'
		reporters: karmaReporters,

		// Configure the coverage reporter
		coverageReporter: {
			dir : 'coverage/client',
			reporters: [
				// Reporters not supporting the `file` property
				{ type: 'html', subdir: 'report-html' },
				{ type: 'lcov', subdir: 'report-lcov' },
				// Output coverage to console
				{ type: 'text' }
			],
			instrumenterOptions: {
				istanbul: { noCompact: true }
			}
		},

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
		// - PhantomJS
		// - IE (only Windows)
		browsers: ['PhantomJS'],

		// If browser does not capture in given timeout [ms], kill it
		captureTimeout: 60000,

		// Continuous Integration mode
		// If true, it capture browsers, run tests and exit
		singleRun: true
	});
}
