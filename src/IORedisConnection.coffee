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
    @_startingUp = true
    @_startupErrorMessage = null

    if @clusterNodes?
      @isCluster = true
      @client = new @Redis.Cluster @clusterNodes, @clientOptions
      @subscriber = new @Redis.Cluster @clusterNodes, @clientOptions
    else if @client? and !@client.duplicate?
      @isCluster = true
      clusterOptions = @client.options?.redisOptions ? @client.options
      @subscriber = new @Redis.Cluster @client.startupNodes, clusterOptions
    else
      @isCluster = false
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
    @ready = @ready.then(
      (clients) =>
        @_startingUp = false
        clients
      (error) =>
        @_startingUp = false
        throw error
    )

  _setup: (client, sub) ->
    client.setMaxListeners 0
    client.on "error", (e) => @_triggerError e
    if sub
      client.on "message", (channel, message) =>
        for instance in @limiters[channel] ? []
          instance?._store.onMessage channel, message

    new @Promise (resolve, reject) =>
      onReady = null
      onFailure = null
      cleanup = =>
        client.removeListener "ready", onReady if onReady?
        client.removeListener "error", onFailure if onFailure?
        client.removeListener "close", onFailure if onFailure?
        client.removeListener "end", onFailure if onFailure?
      onReady = =>
        cleanup()
        resolve client
      onFailure = (error=new Error("Connection is closed.")) =>
        cleanup()
        reject error
      if client.status == "ready"
        resolve client
      else
        client.once "ready", onReady
        client.once "error", onFailure
        client.once "close", onFailure
        client.once "end", onFailure

  _callCommand: (client, cmd) ->
    client.call cmd...

  _runClusterCommand: (client, cmd) ->
    [name, args...] = cmd
    method = name?.toLowerCase?()
    if typeof client[method] == "function"
      client[method] args...
    else
      @_callCommand client, cmd

  _triggerError: (error) ->
    return if @terminated

    if @_startingUp
      message = error?.message ? "#{error}"
      return if message == @_startupErrorMessage
      @_startupErrorMessage = message

    @Events.trigger "error", error

  _loadScript: (name) ->
    payload = Scripts.payload name
    @_callCommand(@client, ["SCRIPT", "LOAD", payload])
    .then (sha) =>
      @shas[name] = sha
      sha

  _loadScripts: ->
    if @isCluster
      masters = @client.nodes "master"
      @Promise.all Scripts.names.map (name) =>
        payload = Scripts.payload name
        @Promise.all masters.map (client) -> client.call "SCRIPT", "LOAD", payload
        .then ([sha]) =>
          @shas[name] = sha
          sha
    else
      Scripts.names.forEach (name) =>
        @client.defineCommand name, {
          lua: Scripts.payload name
        }
      @Promise.resolve()

  _disconnectClient: (client, flush) ->
    return @Promise.resolve() unless client?

    if flush
      client.quit()
    else
      client.disconnect()
      @Promise.resolve()

  __runCommand__: (cmd) ->
    await @ready
    if @isCluster then @_runClusterCommand @client, cmd
    else @_callCommand @client, cmd

  __addLimiter__: (instance) ->
    channels = await @Promise.all [instance.channel(), instance.channel_client()]
    for channel in channels
      listeners = @limiters[channel] ?= []
      first = listeners.length == 0
      listeners.push instance unless listeners.indexOf(instance) >= 0
      await @subscriber.subscribe channel if first
    instance

  __removeLimiter__: (instance) ->
    channels = await @Promise.all [instance.channel(), instance.channel_client()]
    ready = await @ready.then((=> true), (=> false))
    for channel in channels
      listeners = (@limiters[channel] ? []).filter (listener) -> listener != instance
      if listeners.length > 0 then @limiters[channel] = listeners
      else delete @limiters[channel]
      if listeners.length == 0 and ready and !@terminated
        try
          await @subscriber.unsubscribe channel
        catch error
          null

  __runScript__: (name, id, args) ->
    await @ready
    keys = Scripts.keys name, id
    if @isCluster
      sha = @shas[name] ? await @_loadScript name
      try
        await @client.evalsha sha, keys.length, keys.concat(args)...
      catch error
        if /NOSCRIPT/i.test(error.message)
          sha = await @_loadScript name
          await @client.evalsha sha, keys.length, keys.concat(args)...
        else
          throw error
    else
      @client[name] [keys.length].concat(keys, args)...

  disconnect: (flush=true) ->
    seen = new Set()
    for channel in Object.keys @limiters
      for instance in @limiters[channel] ? []
        continue unless instance? and !seen.has(instance)
        seen.add instance
        clearInterval instance._store.heartbeat
    @limiters = {}
    @terminated = true

    await @ready.catch -> null
    await @Promise.all [@_disconnectClient(@client, flush), @_disconnectClient(@subscriber, flush)]

module.exports = IORedisConnection
