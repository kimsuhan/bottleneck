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
      if (this.clusterNodes != null) {
        this.client = new this.Redis.Cluster(this.clusterNodes, this.clientOptions);
        this.subscriber = new this.Redis.Cluster(this.clusterNodes, this.clientOptions);
      } else if ((this.client != null) && (this.client.duplicate == null)) {
        clusterOptions = (ref = (ref1 = this.client.options) != null ? ref1.redisOptions : void 0) != null ? ref : this.client.options;
        this.subscriber = new this.Redis.Cluster(this.client.startupNodes, clusterOptions);
      } else {
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
    }

    _setup(client, sub) {
      client.setMaxListeners(0);
      client.on("error", (e) => {
        return this.Events.trigger("error", e);
      });
      if (sub) {
        client.on("message", (channel, message) => {
          var ref;
          return (ref = this.limiters[channel]) != null ? ref._store.onMessage(channel, message) : void 0;
        });
      }
      return new this.Promise((resolve) => {
        if (client.status === "ready") {
          return resolve(client);
        } else {
          return client.once("ready", () => {
            return resolve(client);
          });
        }
      });
    }

    _callCommand(client, cmd) {
      return client.call(...cmd);
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
      return this._callCommand(this.client, cmd);
    }

    async __addLimiter__(instance) {
      var channel, channels, i, len;
      channels = (await this.Promise.all([instance.channel(), instance.channel_client()]));
      for (i = 0, len = channels.length; i < len; i++) {
        channel = channels[i];
        this.limiters[channel] = instance;
        await this.subscriber.subscribe(channel);
      }
      return instance;
    }

    async __removeLimiter__(instance) {
      var channel, channels, i, len, results;
      channels = (await this.Promise.all([instance.channel(), instance.channel_client()]));
      results = [];
      for (i = 0, len = channels.length; i < len; i++) {
        channel = channels[i];
        if (!this.terminated) {
          await this.subscriber.unsubscribe(channel);
        }
        results.push(delete this.limiters[channel]);
      }
      return results;
    }

    async __runScript__(name, id, args) {
      var error, keys, ref, sha;
      await this.ready;
      keys = Scripts.keys(name, id);
      sha = (ref = this.shas[name]) != null ? ref : (await this._loadScript(name));
      try {
        return this._callCommand(this.client, ["EVALSHA", sha, keys.length].concat(keys, args));
      } catch (error1) {
        error = error1;
        if (/NOSCRIPT/i.test(error.message)) {
          sha = (await this._loadScript(name));
          return this._callCommand(this.client, ["EVALSHA", sha, keys.length].concat(keys, args));
        } else {
          throw error;
        }
      }
    }

    async disconnect(flush = true) {
      var i, k, len, ref;
      ref = Object.keys(this.limiters);
      for (i = 0, len = ref.length; i < len; i++) {
        k = ref[i];
        clearInterval(this.limiters[k]._store.heartbeat);
      }
      this.limiters = {};
      this.terminated = true;
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
