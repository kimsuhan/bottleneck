parser = require "./parser"
Events = require "./Events"
Scripts = require "./Scripts"

class IORedisConnection
  datastore: "ioredis"
  defaults:
    Redis: null
    clientOptions: {}
    clusterNodes: null
    client: null
    Promise: Promise
    Events: null

  constructor: (options={}) ->
    parser.load options, @defaults, @
    @Redis ?= eval("require")("ioredis") # Obfuscated or else Webpack/Angular will try to inline the optional ioredis module. To override this behavior: pass the ioredis module to Bottleneck as the 'Redis' option.
    @Events ?= new Events @
    @terminated = false

    if @clusterNodes?
      @client = new @Redis.Cluster @clusterNodes, @clientOptions
      @subscriber = new @Redis.Cluster @clusterNodes, @clientOptions
    else if @client? and !@client.duplicate?
      clusterOptions = @client.options?.redisOptions ? @client.options
      @subscriber = new @Redis.Cluster @client.startupNodes, clusterOptions
    else
      @client ?= new @Redis @clientOptions
      @subscriber = @client.duplicate()

    @limiters = {}
    @shas = {}

    @ready = @Promise.all([@_setup(@client, false), @_setup(@subscriber, true)])
    .then =>
      @_loadScripts()
    .then =>
      client: @client
      subscriber: @subscriber

  _setup: (client, sub) ->
    client.setMaxListeners 0
    client.on "error", (e) => @Events.trigger "error", e
    if sub
      client.on "message", (channel, message) =>
        @limiters[channel]?._store.onMessage channel, message

    new @Promise (resolve) =>
      if client.status == "ready"
        resolve client
      else
        client.once "ready", => resolve client

  _callCommand: (client, cmd) ->
    client.call cmd...

  _loadScript: (name) ->
    payload = Scripts.payload name
    @_callCommand(@client, ["SCRIPT", "LOAD", payload])
    .then (sha) =>
      @shas[name] = sha
      sha

  _loadScripts: -> @Promise.all(Scripts.names.map (name) => @_loadScript name)

  _disconnectClient: (client, flush) ->
    return @Promise.resolve() unless client?

    if flush
      client.quit()
    else
      client.disconnect()
      @Promise.resolve()

  __runCommand__: (cmd) ->
    await @ready
    @_callCommand @client, cmd

  __addLimiter__: (instance) ->
    channels = await @Promise.all [instance.channel(), instance.channel_client()]
    for channel in channels
      @limiters[channel] = instance
      await @subscriber.subscribe channel
    instance

  __removeLimiter__: (instance) ->
    channels = await @Promise.all [instance.channel(), instance.channel_client()]
    for channel in channels
      await @subscriber.unsubscribe channel unless @terminated
      delete @limiters[channel]

  __runScript__: (name, id, args) ->
    await @ready
    keys = Scripts.keys name, id
    sha = @shas[name] ? await @_loadScript name

    try
      @_callCommand @client, ["EVALSHA", sha, keys.length].concat(keys, args)
    catch error
      if /NOSCRIPT/i.test(error.message)
        sha = await @_loadScript name
        @_callCommand @client, ["EVALSHA", sha, keys.length].concat(keys, args)
      else
        throw error

  disconnect: (flush=true) ->
    clearInterval(@limiters[k]._store.heartbeat) for k in Object.keys @limiters
    @limiters = {}
    @terminated = true

    await @Promise.all [@_disconnectClient(@client, flush), @_disconnectClient(@subscriber, flush)]

module.exports = IORedisConnection
