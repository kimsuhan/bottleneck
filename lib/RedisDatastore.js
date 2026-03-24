var BottleneckError, IORedisConnection, RedisConnection, RedisDatastore, parser;

parser = require("./parser");

BottleneckError = require("./BottleneckError");

RedisConnection = require("./RedisConnection");

IORedisConnection = require("./IORedisConnection");

RedisDatastore = class RedisDatastore {
  constructor(instance, storeOptions, storeInstanceOptions) {
    this.instance = instance;
    this.storeOptions = storeOptions;
    this.originalId = this.instance.id;
    this.clientId = this.instance._randomIndex();
    parser.load(storeInstanceOptions, storeInstanceOptions, this);
    this.clients = {};
    this.capacityPriorityCounters = {};
    this.sharedConnection = this.connection != null;
    if (this.connection == null) {
      this.connection = this.instance.datastore === "redis" ? new RedisConnection({
        Redis: this.Redis,
        clientOptions: this.clientOptions,
        Promise: this.Promise,
        Events: this.instance.Events
      }) : this.instance.datastore === "ioredis" ? new IORedisConnection({
        Redis: this.Redis,
        clientOptions: this.clientOptions,
        clusterNodes: this.clusterNodes,
        Promise: this.Promise,
        Events: this.instance.Events
      }) : void 0;
    }
    this.instance.connection = this.connection;
    this.instance.datastore = this.connection.datastore;
    this.ready = this.connection.ready.then((clients) => {
      this.clients = clients;
      return this.runScript("init", this.prepareInitSettings(this.clearDatastore));
    }).then(() => {
      return this.connection.__addLimiter__(this.instance);
    }).then(() => {
      return this.runScript("register_client", [this.instance.queued()]);
    }).then(() => {
      var base;
      if (typeof (base = (this.heartbeat = setInterval(() => {
        return this.runScript("heartbeat", []).catch((e) => {
          return this.instance.Events.trigger("error", e);
        });
      }, this.heartbeatInterval))).unref === "function") {
        base.unref();
      }
      return this.clients;
    });
  }

  async __publish__(message) {
    var client;
    ({client} = (await this.ready));
    return client.publish(this.instance.channel(), `message:${message.toString()}`);
  }

  async onMessage(channel, message) {
    var capacity, counter, data, drained, e, newCapacity, pos, priorityClient, rawCapacity, type;
    try {
      pos = message.indexOf(":");
      [type, data] = [message.slice(0, pos), message.slice(pos + 1)];
      if (type === "capacity") {
        return (await this.instance._drainAll(data.length > 0 ? ~~data : void 0));
      } else if (type === "capacity-priority") {
        [rawCapacity, priorityClient, counter] = data.split(":");
        capacity = rawCapacity.length > 0 ? ~~rawCapacity : void 0;
        if (priorityClient === this.clientId) {
          drained = (await this.instance._drainAll(capacity));
          newCapacity = capacity != null ? capacity - (drained || 0) : "";
          return (await this.clients.client.publish(this.instance.channel(), `capacity-priority:${newCapacity}::${counter}`));
        } else if (priorityClient === "") {
          clearTimeout(this.capacityPriorityCounters[counter]);
          delete this.capacityPriorityCounters[counter];
          return this.instance._drainAll(capacity);
        } else {
          return this.capacityPriorityCounters[counter] = setTimeout(async() => {
            var e;
            try {
              delete this.capacityPriorityCounters[counter];
              await this.runScript("blacklist_client", [priorityClient]);
              return (await this.instance._drainAll(capacity));
            } catch (error1) {
              e = error1;
              return this.instance.Events.trigger("error", e);
            }
          }, 1000);
        }
      } else if (type === "message") {
        return this.instance.Events.trigger("message", data);
      } else if (type === "blocked") {
        return (await this.instance._dropAllQueued());
      }
    } catch (error1) {
      e = error1;
      return this.instance.Events.trigger("error", e);
    }
  }

  __disconnect__(flush) {
    clearInterval(this.heartbeat);
    if (this.sharedConnection) {
      return this.connection.__removeLimiter__(this.instance);
    } else {
      return this.connection.disconnect(flush);
    }
  }

  normalizeError(error) {
    var normalized, ref;
    if ((error != null ? error.message : void 0) == null) {
      return error;
    }
    normalized = (ref = error.message.match(/(SETTINGS_KEY_NOT_FOUND|UNKNOWN_CLIENT|OVERWEIGHT:[^ ]+)/)) != null ? ref[1] : void 0;
    if (normalized != null) {
      error.message = normalized;
    }
    return error;
  }

  async runScript(name, args) {
    var all_args;
    if (!(name === "init" || name === "register_client")) {
      await this.ready;
    }
    all_args = [Date.now(), this.clientId].concat(args);
    this.instance.Events.trigger("debug", `Calling Redis script: ${name}.lua`, all_args);
    return this.connection.__runScript__(name, this.originalId, all_args).catch((error) => {
      var e;
      e = this.normalizeError(error);
      if (e.message === "SETTINGS_KEY_NOT_FOUND") {
        if (name === "heartbeat") {
          return this.Promise.resolve();
        } else {
          return this.runScript("init", this.prepareInitSettings(false)).then(() => {
            return this.runScript(name, args);
          });
        }
      } else if (e.message === "UNKNOWN_CLIENT") {
        return this.runScript("register_client", [this.instance.queued()]).then(() => {
          return this.runScript(name, args);
        });
      } else {
        return this.Promise.reject(e);
      }
    });
  }

  prepareArray(arr) {
    var i, len, results, x;
    results = [];
    for (i = 0, len = arr.length; i < len; i++) {
      x = arr[i];
      results.push(x != null ? x.toString() : "");
    }
    return results;
  }

  prepareObject(obj) {
    var arr, k, v;
    arr = [];
    for (k in obj) {
      v = obj[k];
      arr.push(k, (v != null ? v.toString() : ""));
    }
    return arr;
  }

  prepareInitSettings(clear) {
    var args;
    args = this.prepareObject(Object.assign({}, this.storeOptions, {
      id: this.originalId,
      channel: this.instance.channel(),
      version: this.instance.version,
      groupTimeout: this.timeout,
      clientTimeout: this.clientTimeout
    }));
    args.unshift((clear ? 1 : 0), this.instance.version);
    return args;
  }

  convertBool(b) {
    return !!b;
  }

  async __updateSettings__(options) {
    await this.runScript("update_settings", this.prepareObject(options));
    return parser.overwrite(options, options, this.storeOptions);
  }

  __running__() {
    return this.runScript("running", []);
  }

  __queued__() {
    return this.runScript("queued", []);
  }

  __done__() {
    return this.runScript("done", []);
  }

  async __groupCheck__() {
    return this.convertBool((await this.runScript("group_check", [])));
  }

  __incrementReservoir__(incr) {
    return this.runScript("increment_reservoir", [incr]);
  }

  __currentReservoir__() {
    return this.runScript("current_reservoir", []);
  }

  async __check__(weight) {
    return this.convertBool((await this.runScript("check", this.prepareArray([weight]))));
  }

  async __register__(index, weight, expiration) {
    var reservoir, success, wait;
    [success, wait, reservoir] = (await this.runScript("register", this.prepareArray([index, weight, expiration])));
    return {
      success: this.convertBool(success),
      wait,
      reservoir
    };
  }

  async __submit__(queueLength, weight) {
    var blocked, e, error, maxConcurrent, overweight, reachedHWM, strategy;
    try {
      [reachedHWM, blocked, strategy] = (await this.runScript("submit", this.prepareArray([queueLength, weight])));
      return {
        reachedHWM: this.convertBool(reachedHWM),
        blocked: this.convertBool(blocked),
        strategy
      };
    } catch (error1) {
      error = error1;
      e = this.normalizeError(error);
      if (e.message.indexOf("OVERWEIGHT") === 0) {
        [overweight, weight, maxConcurrent] = e.message.split(":");
        throw new BottleneckError(`Impossible to add a job having a weight of ${weight} to a limiter having a maxConcurrent setting of ${maxConcurrent}`);
      } else {
        throw e;
      }
    }
  }

  async __free__(index, weight) {
    var running;
    running = (await this.runScript("free", this.prepareArray([index])));
    return {running};
  }

};

module.exports = RedisDatastore;
