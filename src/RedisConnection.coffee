parser = require "./parser"
Events = require "./Events"
Scripts = require "./Scripts"

class RedisConnection
  datastore: "redis"
  defaults:
    Redis: null
    clientOptions: {}
    client: null
    Promise: Promise
    Events: null

  constructor: (options={}) ->
    parser.load options, @defaults, @
    @Redis ?= eval("require")("redis") # Obfuscated or else Webpack/Angular will try to inline the optional redis module. To override this behavior: pass the redis module to Bottleneck as the 'Redis' option.
    @Events ?= new Events @
    @terminated = false
    @_startingUp = true
    @_startupErrorMessage = null

    @clientOptions = @_normalizeClientOptions @clientOptions
    @client ?= @Redis.createClient @clientOptions
    @subscriber = @client.duplicate()
    @limiters = {}
    @shas = {}

    @ready = @Promise.all([@_setup(@client), @_setup(@subscriber)])
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

  _normalizeClientOptions: (clientOptions={}) ->
    return clientOptions if clientOptions.socket? or (!clientOptions.host? and !clientOptions.port? and !clientOptions.path?)

    socket = Object.assign {}, clientOptions.socket
    socket.host ?= clientOptions.host if clientOptions.host?
    socket.port ?= clientOptions.port if clientOptions.port?
    socket.path ?= clientOptions.path if clientOptions.path?

    options = Object.assign {}, clientOptions, { socket }
    delete options.host
    delete options.port
    delete options.path
    options

  _setup: (client) ->
    client.setMaxListeners 0
    new @Promise (resolve, reject) =>
      client.on "error", (e) => @_triggerError e
      onReady = null
      onFailure = null
      cleanup = =>
        client.removeListener "ready", onReady if onReady?
        client.removeListener "error", onFailure if onFailure?
        client.removeListener "end", onFailure if onFailure?
      onReady = =>
        cleanup()
        resolve client
      onFailure = (error=new Error("Connection is closed.")) =>
        cleanup()
        reject error
      if client.isReady then return resolve client
      client.once "ready", onReady
      client.once "error", onFailure
      client.once "end", onFailure
      if client.isOpen then return
      client.connect().catch (error) =>
        cleanup()
        reject error

  _commandArgs: (cmd) ->
    args = ((if Buffer.isBuffer(part) then part else "#{part}") for part in cmd)
    args[0] = args[0].toUpperCase()
    args

  _callCommand: (client, cmd) ->
    client.sendCommand @_commandArgs cmd

  _listenersFor: (channel) ->
    @limiters[channel] ?= []

  _dispatchMessage: (channel, message) ->
    for instance in @limiters[channel] ? []
      instance?._store.onMessage channel, message

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

  _loadScripts: -> @Promise.all(Scripts.names.map (name) => @_loadScript name)

  _disconnectClient: (client, flush) ->
    return @Promise.resolve() unless client?

    try
      if flush
        if typeof client.close == "function" then @Promise.resolve client.close()
        else if typeof client.quit == "function" then @Promise.resolve client.quit()
        else @Promise.resolve()
      else
        if typeof client.destroy == "function" then client.destroy()
        else if typeof client.disconnect == "function" then client.disconnect()
        @Promise.resolve()
    catch error
      @Promise.resolve()

  __runCommand__: (cmd) ->
    await @ready
    @_callCommand @client, cmd

  __addLimiter__: (instance) ->
    channels = await @Promise.all [instance.channel(), instance.channel_client()]
    for channel in channels
      listeners = @_listenersFor channel
      first = listeners.length == 0
      listeners.push instance unless listeners.indexOf(instance) >= 0
      if first
        await @subscriber.subscribe channel, (message) =>
          @_dispatchMessage channel, message
    instance

  __removeLimiter__: (instance) ->
    channels = await @Promise.all [instance.channel(), instance.channel_client()]
    ready = await @ready.then((=> true), (=> false))
    for channel in channels
      listeners = @_listenersFor(channel).filter (listener) -> listener != instance
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
    sha = @shas[name] ? await @_loadScript name

    try
      await @_callCommand @client, ["EVALSHA", sha, keys.length].concat(keys, args)
    catch error
      if /NOSCRIPT/i.test(error.message)
        sha = await @_loadScript name
        await @_callCommand @client, ["EVALSHA", sha, keys.length].concat(keys, args)
      else
        throw error

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

module.exports = RedisConnection
