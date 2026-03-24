var makeTest = require('./context')
var Bottleneck = require('./bottleneck')
var assert = require('assert')
var Redis = require('ioredis')

if (process.env.DATASTORE === 'ioredis') {
  describe('ioredis-only', function () {
    var c
    var clusterSupport = null
    var clusterNodes = function () {
      return [{
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT
      }]
    }
    var hasClusterSupport = function () {
      if (clusterSupport != null) return clusterSupport

      var client = new Redis({
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT
      })

      clusterSupport = client.call('cluster', 'info')
        .then(function () {
          return true
        })
        .catch(function (err) {
          if (/cluster support disabled/i.test(err.message)) return false
          throw err
        })
        .then(function (supported) {
          client.disconnect()
          return supported
        }, function (err) {
          client.disconnect()
          throw err
        })

      return clusterSupport
    }

    afterEach(function () {
      return c.limiter.disconnect(false)
    })

    it('Should accept ioredis lib override', function () {
      c = makeTest({
        maxConcurrent: 2,
        Redis,
        clientOptions: {}
      })

      c.mustEqual(c.limiter.datastore, 'ioredis')
    })

    it('Should connect in Redis Cluster mode', async function () {
      if (!(await hasClusterSupport())) this.skip()

      c = makeTest({
        maxConcurrent: 2,
        clientOptions: {},
        clusterNodes: clusterNodes()
      })

      await c.ready
      c.mustEqual(c.limiter.datastore, 'ioredis')
      assert(c.limiter._store.connection.client.nodes().length >= 0)
    })

    it('Should connect in Redis Cluster mode with premade client', async function () {
      if (!(await hasClusterSupport())) this.skip()

      var client = new Redis.Cluster(clusterNodes())
      var connection = new Bottleneck.IORedisConnection({ client })
      c = makeTest({
        maxConcurrent: 2,
        connection
      })

      await c.ready
      c.mustEqual(c.limiter.datastore, 'ioredis')
      assert(c.limiter._store.connection.client.nodes().length >= 0)
      await connection.disconnect(false)
    })

    it('Should accept existing connections', function () {
      var connection = new Bottleneck.IORedisConnection()
      connection.id = 'super-connection'
      c = makeTest({
        minTime: 50,
        connection
      })

      c.pNoErrVal(c.limiter.schedule(c.promise, null, 1), 1)
      c.pNoErrVal(c.limiter.schedule(c.promise, null, 2), 2)

      return c.last()
        .then(function (results) {
          c.checkResultsOrder([[1], [2]])
          c.checkDuration(50)
          c.mustEqual(c.limiter.connection.id, 'super-connection')
          c.mustEqual(c.limiter.datastore, 'ioredis')

          return c.limiter.disconnect()
        })
        .then(function () {
        // Shared connections should not be disconnected by the limiter
          c.mustEqual(c.limiter.clients().client.status, 'ready')
          return connection.disconnect()
        })
    })

    it('Should accept existing redis clients', function () {
      var client = new Redis()
      client.id = 'super-client'

      var connection = new Bottleneck.IORedisConnection({ client })
      connection.id = 'super-connection'
      c = makeTest({
        minTime: 50,
        connection
      })

      c.pNoErrVal(c.limiter.schedule(c.promise, null, 1), 1)
      c.pNoErrVal(c.limiter.schedule(c.promise, null, 2), 2)

      return c.last()
        .then(function (results) {
          c.checkResultsOrder([[1], [2]])
          c.checkDuration(50)
          c.mustEqual(c.limiter.clients().client.id, 'super-client')
          c.mustEqual(c.limiter.connection.id, 'super-connection')
          c.mustEqual(c.limiter.datastore, 'ioredis')

          return c.limiter.disconnect()
        })
        .then(function () {
        // Shared connections should not be disconnected by the limiter
          c.mustEqual(c.limiter.clients().client.status, 'ready')
          return connection.disconnect()
        })
    })

    it('Should trigger error events on the shared connection', function (done) {
      var connection = new Bottleneck.IORedisConnection({
        clientOptions: {
          port: 1
        }
      })
      connection.on('error', function (err) {
        c.mustEqual(c.limiter.datastore, 'ioredis')
        connection.disconnect()
        done()
      })

      c = makeTest({ connection })
      c.limiter.on('error', function (err) {
        done(err)
      })
    })
  })
}
