'use strict'

module.exports = function (grunt) {
	require('jit-grunt')(grunt)

	// Project Configuration
	grunt.initConfig({
		pkg: grunt.file.readJSON('package.json'),
		harp: {
			server: {
				server: true,
				source: 'src'
			},
			dist: {
				source: 'src'
			}
		},
		mocha_istanbul: {
			coverage: {
					src: 'test/**/*.js'
			},
			coveralls: {
					src: 'test/**/*.js', 
					options: {
						coverage: true, // this will make the grunt.event.on('coverage') event listener to be triggered
						check: {
								lines: 75,
								statements: 75
						},
						root: './lib', // define where the cover task should consider the root of libraries that are covered by tests
						reportFormats: ['cobertura','lcovonly']
					}
			}
		},
		istanbul_check_coverage: {
			default: {
				options: {
					coverageFolder: 'coverage*', // will check both coverage folders and merge the coverage results
					check: {
						lines: 80,
						statements: 80
					}
				}
			}
		},
		karma: {
			unit: {
				configFile: 'karma.conf.js'
			}
		},
		protractor: {
			options: {
				configFile: 'protractor.conf.js',
				noColor: false,
				webdriverManagerUpdate: true
			},
			e2e: {
				options: {
					args: {} // Target-specific arguments
				}
			}
		}
	})

	grunt.event.on('coverage', function(lcovFileContents, done) {
		// Set coverage config so karma-coverage knows to run coverage
		require('coveralls').handleInput(lcovFileContents, function(err) {
			if (err) {
				return done(err)
			}
			done()
		})
	})
	//grunt.loadNpmTasks('grunt-protractor-coverage')

	grunt.registerTask('default', ['harp:server'])

	// Run the project tests
	grunt.registerTask('test:client', ['harp', 'karma:unit'])
	grunt.registerTask('test:e2e', ['harp:server', 'protractor'])
	grunt.registerTask('test', ['harp:server', 'test:client', 'test:e2e'])

	// Run project coverage
	grunt.registerTask('coverage', ['mocha_istanbul:coverage', 'karma:unit'])
}