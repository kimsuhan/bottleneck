var Events, RedisConnection, Scripts, parser;

parser = require("./parser");

Events = require("./Events");

Scripts = require("./Scripts");

RedisConnection = (function() {
  class RedisConnection {
    constructor(options = {}) {
      parser.load(options, this.defaults, this);
      if (this.Redis == null) {
        this.Redis = eval("require")("redis"); // Obfuscated or else Webpack/Angular will try to inline the optional redis module. To override this behavior: pass the redis module to Bottleneck as the 'Redis' option.
      }
      if (this.Events == null) {
        this.Events = new Events(this);
      }
      this.terminated = false;
      this._startingUp = true;
      this._startupErrorMessage = null;
      this.clientOptions = this._normalizeClientOptions(this.clientOptions);
      if (this.client == null) {
        this.client = this.Redis.createClient(this.clientOptions);
      }
      this.subscriber = this.client.duplicate();
      this.limiters = {};
      this.shas = {};
      this.ready = this.Promise.all([this._setup(this.client), this._setup(this.subscriber)]).then(() => {
        return this._loadScripts();
      }).then(() => {
        return {
          client: this.client,
          subscriber: this.subscriber
        };
      });
      this.ready = this.ready.then((clients) => {
        this._startingUp = false;
        return clients;
      }, (error) => {
        this._startingUp = false;
        throw error;
      });
    }

    _normalizeClientOptions(clientOptions = {}) {
      var options, socket;
      if ((clientOptions.socket != null) || ((clientOptions.host == null) && (clientOptions.port == null) && (clientOptions.path == null))) {
        return clientOptions;
      }
      socket = Object.assign({}, clientOptions.socket);
      if (clientOptions.host != null) {
        if (socket.host == null) {
          socket.host = clientOptions.host;
        }
      }
      if (clientOptions.port != null) {
        if (socket.port == null) {
          socket.port = clientOptions.port;
        }
      }
      if (clientOptions.path != null) {
        if (socket.path == null) {
          socket.path = clientOptions.path;
        }
      }
      options = Object.assign({}, clientOptions, {socket});
      delete options.host;
      delete options.port;
      delete options.path;
      return options;
    }

    _setup(client) {
      client.setMaxListeners(0);
      return new this.Promise((resolve, reject) => {
        var cleanup, onFailure, onReady;
        client.on("error", (e) => {
          return this._triggerError(e);
        });
        onReady = null;
        onFailure = null;
        cleanup = () => {
          if (onReady != null) {
            client.removeListener("ready", onReady);
          }
          if (onFailure != null) {
            client.removeListener("error", onFailure);
          }
          if (onFailure != null) {
            return client.removeListener("end", onFailure);
          }
        };
        onReady = () => {
          cleanup();
          return resolve(client);
        };
        onFailure = (error = new Error("Connection is closed.")) => {
          cleanup();
          return reject(error);
        };
        if (client.isReady) {
          return resolve(client);
        }
        client.once("ready", onReady);
        client.once("error", onFailure);
        client.once("end", onFailure);
        if (client.isOpen) {
          return;
        }
        return client.connect().catch((error) => {
          cleanup();
          return reject(error);
        });
      });
    }

    _commandArgs(cmd) {
      var args, part;
      args = (function() {
        var i, len, results;
        results = [];
        for (i = 0, len = cmd.length; i < len; i++) {
          part = cmd[i];
          results.push(Buffer.isBuffer(part) ? part : `${part}`);
        }
        return results;
      })();
      args[0] = args[0].toUpperCase();
      return args;
    }

    _callCommand(client, cmd) {
      return client.sendCommand(this._commandArgs(cmd));
    }

    _listenersFor(channel) {
      var base;
      return (base = this.limiters)[channel] != null ? base[channel] : base[channel] = [];
    }

    _dispatchMessage(channel, message) {
      var i, instance, len, ref, ref1, results;
      ref1 = (ref = this.limiters[channel]) != null ? ref : [];
      results = [];
      for (i = 0, len = ref1.length; i < len; i++) {
        instance = ref1[i];
        results.push(instance != null ? instance._store.onMessage(channel, message) : void 0);
      }
      return results;
    }

    _triggerError(error) {
      var message, ref;
      if (this.terminated) {
        return;
      }
      if (this._startingUp) {
        message = (ref = error != null ? error.message : void 0) != null ? ref : `${error}`;
        if (message === this._startupErrorMessage) {
          return;
        }
        this._startupErrorMessage = message;
      }
      return this.Events.trigger("error", error);
    }

    _loadScript(name) {
      var payload;
      payload = Scripts.payload(name);
      return this._callCommand(this.client, ["SCRIPT", "LOAD", payload]).then((sha) => {
        this.shas[name] = sha;
        return sha;
      });
    }

    _loadScripts() {
      return this.Promise.all(Scripts.names.map((name) => {
        return this._loadScript(name);
      }));
    }

    _disconnectClient(client, flush) {
      var error;
      if (client == null) {
        return this.Promise.resolve();
      }
      try {
        if (flush) {
          if (typeof client.close === "function") {
            return this.Promise.resolve(client.close());
          } else if (typeof client.quit === "function") {
            return this.Promise.resolve(client.quit());
          } else {
            return this.Promise.resolve();
          }
        } else {
          if (typeof client.destroy === "function") {
            client.destroy();
          } else if (typeof client.disconnect === "function") {
            client.disconnect();
          }
          return this.Promise.resolve();
        }
      } catch (error1) {
        error = error1;
        return this.Promise.resolve();
      }
    }

    async __runCommand__(cmd) {
      await this.ready;
      return this._callCommand(this.client, cmd);
    }

    async __addLimiter__(instance) {
      var channel, channels, first, i, len, listeners;
      channels = (await this.Promise.all([instance.channel(), instance.channel_client()]));
      for (i = 0, len = channels.length; i < len; i++) {
        channel = channels[i];
        listeners = this._listenersFor(channel);
        first = listeners.length === 0;
        if (!(listeners.indexOf(instance) >= 0)) {
          listeners.push(instance);
        }
        if (first) {
          await this.subscriber.subscribe(channel, (message) => {
            return this._dispatchMessage(channel, message);
          });
        }
      }
      return instance;
    }

    async __removeLimiter__(instance) {
      var channel, channels, error, i, len, listeners, ready, results;
      channels = (await this.Promise.all([instance.channel(), instance.channel_client()]));
      ready = (await this.ready.then((() => {
        return true;
      }), (() => {
        return false;
      })));
      results = [];
      for (i = 0, len = channels.length; i < len; i++) {
        channel = channels[i];
        listeners = this._listenersFor(channel).filter(function(listener) {
          return listener !== instance;
        });
        if (listeners.length > 0) {
          this.limiters[channel] = listeners;
        } else {
          delete this.limiters[channel];
        }
        if (listeners.length === 0 && ready && !this.terminated) {
          try {
            results.push((await this.subscriber.unsubscribe(channel)));
          } catch (error1) {
            error = error1;
            results.push(null);
          }
        } else {
          results.push(void 0);
        }
      }
      return results;
    }

    async __runScript__(name, id, args) {
      var error, keys, ref, sha;
      await this.ready;
      keys = Scripts.keys(name, id);
      sha = (ref = this.shas[name]) != null ? ref : (await this._loadScript(name));
      try {
        return (await this._callCommand(this.client, ["EVALSHA", sha, keys.length].concat(keys, args)));
      } catch (error1) {
        error = error1;
        if (/NOSCRIPT/i.test(error.message)) {
          sha = (await this._loadScript(name));
          return (await this._callCommand(this.client, ["EVALSHA", sha, keys.length].concat(keys, args)));
        } else {
          throw error;
        }
      }
    }

    async disconnect(flush = true) {
      var channel, i, instance, j, len, len1, ref, ref1, ref2, seen;
      seen = new Set();
      ref = Object.keys(this.limiters);
      for (i = 0, len = ref.length; i < len; i++) {
        channel = ref[i];
        ref2 = (ref1 = this.limiters[channel]) != null ? ref1 : [];
        for (j = 0, len1 = ref2.length; j < len1; j++) {
          instance = ref2[j];
          if (!((instance != null) && !seen.has(instance))) {
            continue;
          }
          seen.add(instance);
          clearInterval(instance._store.heartbeat);
        }
      }
      this.limiters = {};
      this.terminated = true;
      await this.ready.catch(function() {
        return null;
      });
      return (await this.Promise.all([this._disconnectClient(this.client, flush), this._disconnectClient(this.subscriber, flush)]));
    }

  };

  RedisConnection.prototype.datastore = "redis";

  RedisConnection.prototype.defaults = {
    Redis: null,
    clientOptions: {},
    client: null,
    Promise: Promise,
    Events: null
  };

  return RedisConnection;

}).call(this);

module.exports = RedisConnection;
