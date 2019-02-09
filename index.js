'use strict'

const env = process.env
const cp = require('child_process')
const camelCase = require('camel-case')
const parallel = require('run-parallel-limit')
const xtend = require('xtend')
const deprecate = require('deprecate')

const HOST_NON_EXISTENT = /host does not exist/i
const ALREADY_RUNNING = /already running/i
const ALREADY_STOPPED = /already stopped/
const NEWLINE = /\r?\n/
const LIST_COLUMNS_SEP = ','

const LIST_COLUMNS =
  [ 'Name',
    'Active',
    'ActiveHost',
    'ActiveSwarm',
    'DriverName',
    'State',
    'URL',
    'Swarm',
    'Error',
    'DockerVersion',
    'ResponseTime' ]

class Machine {
  constructor (name = 'default', bin = 'docker-machine') {
    this.name = name;
    this.bin = bin;
  }

  command (args, done) {
    return cp.execFile(this.bin, [].concat(args), {
      cwd: env.DOCKER_TOOLBOX_INSTALL_PATH || '.',
      encoding: 'utf8'
    }, done)
  }

  status (name, done) {
    this.command(['status', name], (err, stdout) => {
      if (err) done(err)
      else done(null, stdout.trim().toLowerCase())
    })
  }

  isRunning (name, done) {
    this.status(name, (err, status) => {
      done(err, status === 'running')
    })
  }

  create (name, driver, options, done) {
    if (typeof name !== 'string' || name === '') {
      throw new TypeError('name is required')
    }

    if (typeof driver !== 'string' || driver === '') {
      throw new TypeError('driver is required')
    }

    if (typeof options === 'function') {
      done = options
      options = {}
    }

    const args = ['create', '--driver', driver]

    for (let key in options) {
      if (options.hasOwnProperty(key)) {
        args.push(`--${key}`, options[key])
      }
    }

    args.push(name)

    return this.command(args, done)
  }

  start (name, done) {
    this.command(['start', name], (err) => {
      if (HOST_NON_EXISTENT.test(err)) {
        done(new Error(`Docker host "${name}" does not exist`))
      } else if (ALREADY_RUNNING.test(err)) {
        done()
      } else {
        done(err)
      }
    })
  }

  stop (name, done) {
    this.command(['stop', name], (err) => {
      if (HOST_NON_EXISTENT.test(err)) {
        done(new Error(`Docker host "${name}" does not exist`))
      } else if (ALREADY_STOPPED.test(err)) {
        done()
      } else {
        done(err)
      }
    })
  }

  kill (name, done) {
    this.command(['kill', name], (err) => {
      if (HOST_NON_EXISTENT.test(err)) {
        done(new Error(`Docker host "${name}" does not exist`))
      } else if (ALREADY_STOPPED.test(err)) {
        done()
      } else {
        done(err)
      }
    })
  }

  env (name, opts, done) {
    if (typeof opts === 'function') {
      done = opts
      opts = {}
    }

    const args = ['env']

    if (opts.json) {
      deprecate(
        'The "json" option has been renamed to "parse" and',
        'will be removed in node-docker-machine v3.x.x.'
      )

      opts = xtend(opts, { parse: true })
    }

    if (opts.parse) args.push('--shell', 'bash')
    else if (opts.shell) args.push('--shell', opts.shell)

    args.push(name)

    this.command(args, function (err, stdout) {
      if (err) return done(err)
      if (!opts.parse) return done(null, stdout.trim())

      const res = {}

      stdout.split(/\n+/).forEach(line => {
        const m = /^export (.+)="([^"]+)/i.exec(line)
        if (m) res[m[1]] = m[2]
      })

      done(null, res)
    })
  }

  ssh (name, cmd, done) {
    if (Array.isArray(cmd)) {
      cmd = cmd.join(' ')
    } else if (typeof cmd !== 'string') {
      throw new TypeError('Command must be an array or string')
    }

    cmd = cmd.trim()
    if (!cmd) throw new TypeError('Command may not be empty')

    this.command(['ssh', name, cmd], done)
  }

  inspect (name, done) {
    this.command(['inspect', name], (err, stdout) => {
      if (err) return done(err)

      try {
        var data = JSON.parse(stdout.trim())
      } catch (err) {
        return done(err)
      }

      done(null, merge({}, data))
    })
  }

  list (opts, done) {
    if (typeof opts === 'function') {
      done = opts
      opts = {}
    }

    // Build template, escape values with URL encoding
    const template = LIST_COLUMNS.map(name => {
      if (name === 'ResponseTime') {
        return `{{ .${name} | printf "%d" }}`
      } else {
        return `{{ .${name} | urlquery }}`
      }
    }).join(LIST_COLUMNS_SEP)

    const args = ['ls', '-f', template]

    // Optionally add a timeout (in seconds)
    // to deal with docker/machine#1696.
    if (opts.timeout) args.push('-t', String(opts.timeout))

    this.command(args, (err, stdout) => {
      if (err) return done(err)

      const machines = stdout.split(NEWLINE).filter(Boolean).map(line => {
        const values = line.split(LIST_COLUMNS_SEP)
        const machine = {}

        LIST_COLUMNS.forEach((name, i) => {
          const key = camelCase(name)
          const val = values[i]

          machine[key] = val === '' ? null : decodeURIComponent(val)
        })

        // ResponseTime is in nanoseconds
        machine.responseTime = parseInt(machine.responseTime) / 1e6
        machine.state = machine.state.toLowerCase()
        machine.activeHost = machine.activeHost === 'true'
        machine.activeSwarm = machine.activeSwarm === 'true'

        if (machine.dockerVersion === 'Unknown') {
          machine.dockerVersion = null
        }

        return machine
      })

      if (!opts.inspect) return done(null, machines)

      // Add additional metadata from `docker-machine inspect <name>`
      parallel(machines.map(machine => next => {
        this.inspect(machine.name, (err, data) => {
          if (err) next(err)
          else next(null, xtend(machine, data))
        })
      }), 4, done)
    })
  }
}

module.exports = Machine

function merge (node, data) {
  for (let key in data) {
    const val = data[key]
    node[camelCase(key)] = isObject(val) ? merge({}, val) : val
  }

  return node
}

function isObject (obj) {
  return typeof obj === 'object' && obj !== null
}
