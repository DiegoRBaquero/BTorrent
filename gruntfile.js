'use strict'

module.exports = function (grunt) {
	require('jit-grunt')(grunt)

	var _ = require('lodash')

	var path = require('path')
	var bowerFiles = require('main-bower-files')

	var bowerDep = bowerFiles('**/**.js').concat(bowerFiles('**/**.css'))
	bowerDep = bowerDep.map(function(file_path){
		var local_path = file_path.split(path.resolve(__dirname))[1]

		if(local_path === '') return '.'+file_path
		return '.'+local_path

	}).filter(function(file_path){
		if(file_path === null) return false
		return true
	})

	bowerDep = bowerDep.concat(['./bower_components/**/*shim.js', './bower_components/**/**.ttf', './bower_components/**/**.css'])

	// Project Configuration
	grunt.initConfig({
		pkg: grunt.file.readJSON('package.json'),
		watch: {
			harp: {
				files: ['src/*'],
				tasks: ['harp:compile', 'harp:server'],
				options: {
					livereload: true,
				}
			},
			bowerFiles: {
				files: ['bower_components/**/*.js', 'bower_components/**/*.css', 'bower_components/**/*.ttf'],
				tasks: ['newer:bower:copy'],
			},
			testUnit: {
				files: 'test/unit/**.js',
				tasks: ['test:client'],
			},
			testE2E: {
				files: 'test/e2e/**.js',
				tasks: ['test:e2e'],
			}
		},
		concurrent: {
			default: ['watch:harp', 'watch:bowerFiles'],
			options: {
				logConcurrentOutput: true,
				limit: 10
			}
		},
		harp: {
			compile: {
				server: false,
				source: 'src',
				dest: 'www'
			},
			server: {
				server: true,
				source: 'src',
				dest: 'www'
			}
		},
		copy: {
		  bower: {
		    files: [
		      // includes files within path
		      {expand: true, src: bowerDep, dest: 'src/'},
		    ],
		  },
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
					root: './www', // define where the cover task should consider the root of libraries that are covered by tests
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

	grunt.registerTask('build', ['newer:copy:bower', 'harp:compile']);

	grunt.registerTask('default', ['build', 'harp:server', 'concurrent:default'])

	// Run the projects' tests
	grunt.registerTask('test:client', ['build', 'karma:unit'])
	grunt.registerTask('test:e2e', ['build', 'harp:server', 'protractor'])
	grunt.registerTask('test', ['test:client', 'test:e2e'])

	// Run project coverage
	grunt.registerTask('coverage', ['mocha_istanbul:coverage', 'karma:unit'])
}