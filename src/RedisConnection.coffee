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
      onReady = => resolve client
      if client.isReady then return resolve client
      client.once "ready", onReady
      if client.isOpen then return
      client.connect().catch (error) =>
        client.removeListener "ready", onReady
        reject error

  _commandArgs: (cmd) ->
    args = ((if Buffer.isBuffer(part) then part else "#{part}") for part in cmd)
    args[0] = args[0].toUpperCase()
    args

  _callCommand: (client, cmd) ->
    client.sendCommand @_commandArgs cmd

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
      @limiters[channel] = instance
      await @subscriber.subscribe channel, (message) =>
        @limiters[channel]?._store.onMessage channel, message
    instance

  __removeLimiter__: (instance) ->
    channels = await @Promise.all [instance.channel(), instance.channel_client()]
    ready = await @ready.then((=> true), (=> false))
    for channel in channels
      if ready and !@terminated
        try
          await @subscriber.unsubscribe channel
        catch error
          null
      delete @limiters[channel]

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
    clearInterval(@limiters[k]._store.heartbeat) for k in Object.keys @limiters
    @limiters = {}
    @terminated = true

    await @ready.catch -> null
    await @Promise.all [@_disconnectClient(@client, flush), @_disconnectClient(@subscriber, flush)]

module.exports = RedisConnection
