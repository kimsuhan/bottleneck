var Events, IORedisConnection, Scripts, parser;

parser = require("./parser");

Events = require("./Events");

Scripts = require("./Scripts");

IORedisConnection = (function() {
  class IORedisConnection {
    constructor(options = {}) {
      var clusterOptions, ref, ref1;
      parser.load(options, this.defaults, this);
      if (this.Redis == null) {
        this.Redis = eval("require")("ioredis"); // Obfuscated or else Webpack/Angular will try to inline the optional ioredis module. To override this behavior: pass the ioredis module to Bottleneck as the 'Redis' option.
      }
      if (this.Events == null) {
        this.Events = new Events(this);
      }
      this.terminated = false;
      this._startingUp = true;
      this._startupErrorMessage = null;
      if (this.clusterNodes != null) {
        this.isCluster = true;
        this.client = new this.Redis.Cluster(this.clusterNodes, this.clientOptions);
        this.subscriber = new this.Redis.Cluster(this.clusterNodes, this.clientOptions);
      } else if ((this.client != null) && (this.client.duplicate == null)) {
        this.isCluster = true;
        clusterOptions = (ref = (ref1 = this.client.options) != null ? ref1.redisOptions : void 0) != null ? ref : this.client.options;
        this.subscriber = new this.Redis.Cluster(this.client.startupNodes, clusterOptions);
      } else {
        this.isCluster = false;
        if (this.client == null) {
          this.client = new this.Redis(this.clientOptions);
        }
        this.subscriber = this.client.duplicate();
      }
      this.limiters = {};
      this.shas = {};
      this.ready = this.Promise.all([this._setup(this.client, false), this._setup(this.subscriber, true)]).then(() => {
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

    _setup(client, sub) {
      client.setMaxListeners(0);
      client.on("error", (e) => {
        return this._triggerError(e);
      });
      if (sub) {
        client.on("message", (channel, message) => {
          var i, instance, len, ref, ref1, results;
          ref1 = (ref = this.limiters[channel]) != null ? ref : [];
          results = [];
          for (i = 0, len = ref1.length; i < len; i++) {
            instance = ref1[i];
            results.push(instance != null ? instance._store.onMessage(channel, message) : void 0);
          }
          return results;
        });
      }
      return new this.Promise((resolve, reject) => {
        var cleanup, onFailure, onReady;
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
            client.removeListener("close", onFailure);
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
        if (client.status === "ready") {
          return resolve(client);
        } else {
          client.once("ready", onReady);
          client.once("error", onFailure);
          client.once("close", onFailure);
          return client.once("end", onFailure);
        }
      });
    }

    _callCommand(client, cmd) {
      return client.call(...cmd);
    }

    _runClusterCommand(client, cmd) {
      var args, method, name;
      [name, ...args] = cmd;
      method = name != null ? typeof name.toLowerCase === "function" ? name.toLowerCase() : void 0 : void 0;
      if (typeof client[method] === "function") {
        return client[method](...args);
      } else {
        return this._callCommand(client, cmd);
      }
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
      var masters;
      if (this.isCluster) {
        masters = this.client.nodes("master");
        return this.Promise.all(Scripts.names.map((name) => {
          var payload;
          payload = Scripts.payload(name);
          return this.Promise.all(masters.map(function(client) {
            return client.call("SCRIPT", "LOAD", payload);
          })).then(([sha]) => {
            this.shas[name] = sha;
            return sha;
          });
        }));
      } else {
        Scripts.names.forEach((name) => {
          return this.client.defineCommand(name, {
            lua: Scripts.payload(name)
          });
        });
        return this.Promise.resolve();
      }
    }

    _disconnectClient(client, flush) {
      if (client == null) {
        return this.Promise.resolve();
      }
      if (flush) {
        return client.quit();
      } else {
        client.disconnect();
        return this.Promise.resolve();
      }
    }

    async __runCommand__(cmd) {
      await this.ready;
      if (this.isCluster) {
        return this._runClusterCommand(this.client, cmd);
      } else {
        return this._callCommand(this.client, cmd);
      }
    }

    async __addLimiter__(instance) {
      var base, channel, channels, first, i, len, listeners;
      channels = (await this.Promise.all([instance.channel(), instance.channel_client()]));
      for (i = 0, len = channels.length; i < len; i++) {
        channel = channels[i];
        listeners = (base = this.limiters)[channel] != null ? base[channel] : base[channel] = [];
        first = listeners.length === 0;
        if (!(listeners.indexOf(instance) >= 0)) {
          listeners.push(instance);
        }
        if (first) {
          await this.subscriber.subscribe(channel);
        }
      }
      return instance;
    }

    async __removeLimiter__(instance) {
      var channel, channels, error, i, len, listeners, ready, ref, results;
      channels = (await this.Promise.all([instance.channel(), instance.channel_client()]));
      ready = (await this.ready.then((() => {
        return true;
      }), (() => {
        return false;
      })));
      results = [];
      for (i = 0, len = channels.length; i < len; i++) {
        channel = channels[i];
        listeners = ((ref = this.limiters[channel]) != null ? ref : []).filter(function(listener) {
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
      if (this.isCluster) {
        sha = (ref = this.shas[name]) != null ? ref : (await this._loadScript(name));
        try {
          return (await this.client.evalsha(sha, keys.length, ...keys.concat(args)));
        } catch (error1) {
          error = error1;
          if (/NOSCRIPT/i.test(error.message)) {
            sha = (await this._loadScript(name));
            return (await this.client.evalsha(sha, keys.length, ...keys.concat(args)));
          } else {
            throw error;
          }
        }
      } else {
        return this.client[name](...[keys.length].concat(keys, args));
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

  IORedisConnection.prototype.datastore = "ioredis";

  IORedisConnection.prototype.defaults = {
    Redis: null,
    clientOptions: {},
    clusterNodes: null,
    client: null,
    Promise: Promise,
    Events: null
  };

  return IORedisConnection;

}).call(this);

module.exports = IORedisConnection;
