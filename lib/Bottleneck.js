var Bottleneck, DEFAULT_PRIORITY, Events, Job, LocalDatastore, NUM_PRIORITIES, Queues, RedisDatastore, States, Sync, parser,
  splice = [].splice;

NUM_PRIORITIES = 10;

DEFAULT_PRIORITY = 5;

parser = require("./parser");

Queues = require("./Queues");

Job = require("./Job");

LocalDatastore = require("./LocalDatastore");

RedisDatastore = require("./RedisDatastore");

Events = require("./Events");

States = require("./States");

Sync = require("./Sync");

Bottleneck = (function() {
  class Bottleneck {
    constructor(options = {}, ...invalid) {
      var storeInstanceOptions, storeOptions;
      this._addToQueue = this._addToQueue.bind(this);
      this._validateOptions(options, invalid);
      parser.load(options, this.instanceDefaults, this);
      this._queues = new Queues(NUM_PRIORITIES);
      this._scheduled = {};
      this._states = new States(["RECEIVED", "QUEUED", "RUNNING", "EXECUTING"].concat(this.trackDoneStatus ? ["DONE"] : []));
      this._limiter = null;
      this.Events = new Events(this);
      this._submitLock = new Sync("submit", this.Promise);
      this._registerLock = new Sync("register", this.Promise);
      storeOptions = parser.load(options, this.storeDefaults, {});
      this._store = (function() {
        if (this.datastore === "redis" || this.datastore === "ioredis" || (this.connection != null)) {
          storeInstanceOptions = parser.load(options, this.redisStoreDefaults, {});
          return new RedisDatastore(this, storeOptions, storeInstanceOptions);
        } else if (this.datastore === "local") {
          storeInstanceOptions = parser.load(options, this.localStoreDefaults, {});
          return new LocalDatastore(this, storeOptions, storeInstanceOptions);
        } else {
          throw new Bottleneck.prototype.BottleneckError(`Invalid datastore type: ${this.datastore}`);
        }
      }).call(this);
      this._queues.on("leftzero", () => {
        var ref;
        return (ref = this._store.heartbeat) != null ? typeof ref.ref === "function" ? ref.ref() : void 0 : void 0;
      });
      this._queues.on("zero", () => {
        var ref;
        return (ref = this._store.heartbeat) != null ? typeof ref.unref === "function" ? ref.unref() : void 0 : void 0;
      });
    }

    _validateOptions(options, invalid) {
      if (!((options != null) && typeof options === "object" && invalid.length === 0)) {
        throw new Bottleneck.prototype.BottleneckError("Bottleneck v2 takes a single object argument. Refer to https://github.com/SGrondin/bottleneck#upgrading-to-v2 if you're upgrading from Bottleneck v1.");
      }
    }

    ready() {
      return this._store.ready;
    }

    clients() {
      return this._store.clients;
    }

    channel() {
      return `b_${this.id}`;
    }

    channel_client() {
      return `b_${this.id}_${this._store.clientId}`;
    }

    publish(message) {
      return this._store.__publish__(message);
    }

    disconnect(flush = true) {
      return this._store.__disconnect__(flush);
    }

    chain(_limiter) {
      this._limiter = _limiter;
      return this;
    }

    queued(priority) {
      return this._queues.queued(priority);
    }

    clusterQueued() {
      return this._store.__queued__();
    }

    empty() {
      return this.queued() === 0 && this._submitLock.isEmpty();
    }

    running() {
      return this._store.__running__();
    }

    done() {
      return this._store.__done__();
    }

    jobStatus(id) {
      return this._states.jobStatus(id);
    }

    jobs(status) {
      return this._states.statusJobs(status);
    }

    counts() {
      return this._states.statusCounts();
    }

    _randomIndex() {
      return Math.random().toString(36).slice(2);
    }

    check(weight = 1) {
      return this._store.__check__(weight);
    }

    _clearGlobalState(index) {
      if (this._scheduled[index] != null) {
        clearTimeout(this._scheduled[index].expiration);
        delete this._scheduled[index];
        return true;
      } else {
        return false;
      }
    }

    async _free(index, job, options, eventInfo) {
      var e, running;
      try {
        ({running} = (await this._store.__free__(index, options.weight)));
        this.Events.trigger("debug", `Freed ${options.id}`, eventInfo);
        if (running === 0 && this.empty()) {
          return this.Events.trigger("idle");
        }
      } catch (error1) {
        e = error1;
        return this.Events.trigger("error", e);
      }
    }

    _run(index, job, wait) {
      var clearGlobalState, free, run;
      job.doRun();
      clearGlobalState = this._clearGlobalState.bind(this, index);
      run = this._run.bind(this, index, job);
      free = this._free.bind(this, index, job);
      return this._scheduled[index] = {
        timeout: setTimeout(() => {
          return job.doExecute(this._limiter, clearGlobalState, run, free);
        }, wait),
        expiration: job.options.expiration != null ? setTimeout(function() {
          return job.doExpire(clearGlobalState, run, free);
        }, wait + job.options.expiration) : void 0,
        job: job
      };
    }

    _drainOne(capacity) {
      return this._registerLock.schedule(() => {
        var args, index, next, options, queue;
        if (this.queued() === 0) {
          return this.Promise.resolve(null);
        }
        queue = this._queues.getFirst();
        ({options, args} = next = queue.first());
        if ((capacity != null) && options.weight > capacity) {
          return this.Promise.resolve(null);
        }
        this.Events.trigger("debug", `Draining ${options.id}`, {args, options});
        index = this._randomIndex();
        return this._store.__register__(index, options.weight, options.expiration).then(({success, wait, reservoir}) => {
          var empty;
          this.Events.trigger("debug", `Drained ${options.id}`, {success, args, options});
          if (success) {
            queue.shift();
            empty = this.empty();
            if (empty) {
              this.Events.trigger("empty");
            }
            if (reservoir === 0) {
              this.Events.trigger("depleted", empty);
            }
            this._run(index, next, wait);
            return this.Promise.resolve(options.weight);
          } else {
            return this.Promise.resolve(null);
          }
        });
      });
    }

    _drainAll(capacity, total = 0) {
      return this._drainOne(capacity).then((drained) => {
        var newCapacity;
        if (drained != null) {
          newCapacity = capacity != null ? capacity - drained : capacity;
          return this._drainAll(newCapacity, total + drained);
        } else {
          return this.Promise.resolve(total);
        }
      }).catch((e) => {
        return this.Events.trigger("error", e);
      });
    }

    _dropAllQueued(message) {
      return this._queues.shiftAll(function(job) {
        return job.doDrop({message});
      });
    }

    stop(options = {}) {
      var done, waitForExecuting;
      options = parser.load(options, this.stopDefaults);
      waitForExecuting = (at) => {
        var finished;
        finished = () => {
          var counts;
          counts = this._states.counts;
          return (counts[0] + counts[1] + counts[2] + counts[3]) === at;
        };
        return new this.Promise((resolve, reject) => {
          if (finished()) {
            return resolve();
          } else {
            return this.on("done", () => {
              if (finished()) {
                this.removeAllListeners("done");
                return resolve();
              }
            });
          }
        });
      };
      done = options.dropWaitingJobs ? (this._run = function(index, next) {
        return next.doDrop({
          message: options.dropErrorMessage
        });
      }, this._drainOne = () => {
        return this.Promise.resolve(null);
      }, this._registerLock.schedule(() => {
        return this._submitLock.schedule(() => {
          var k, ref, v;
          ref = this._scheduled;
          for (k in ref) {
            v = ref[k];
            if (this.jobStatus(v.job.options.id) === "RUNNING") {
              clearTimeout(v.timeout);
              clearTimeout(v.expiration);
              v.job.doDrop({
                message: options.dropErrorMessage
              });
            }
          }
          this._dropAllQueued(options.dropErrorMessage);
          return waitForExecuting(0);
        });
      })) : this.schedule({
        priority: NUM_PRIORITIES - 1,
        weight: 0
      }, () => {
        return waitForExecuting(1);
      });
      this._receive = function(job) {
        return job._reject(new Bottleneck.prototype.BottleneckError(options.enqueueErrorMessage));
      };
      this.stop = () => {
        return this.Promise.reject(new Bottleneck.prototype.BottleneckError("stop() has already been called"));
      };
      return done;
    }

    async _addToQueue(job) {
      var args, blocked, error, options, reachedHWM, shifted, strategy;
      ({args, options} = job);
      try {
        ({reachedHWM, blocked, strategy} = (await this._store.__submit__(this.queued(), options.weight)));
      } catch (error1) {
        error = error1;
        this.Events.trigger("debug", `Could not queue ${options.id}`, {args, options, error});
        job.doDrop({error});
        return false;
      }
      if (blocked) {
        job.doDrop();
        return true;
      } else if (reachedHWM) {
        shifted = strategy === Bottleneck.prototype.strategy.LEAK ? this._queues.shiftLastFrom(options.priority) : strategy === Bottleneck.prototype.strategy.OVERFLOW_PRIORITY ? this._queues.shiftLastFrom(options.priority + 1) : strategy === Bottleneck.prototype.strategy.OVERFLOW ? job : void 0;
        if (shifted != null) {
          shifted.doDrop();
        }
        if ((shifted == null) || strategy === Bottleneck.prototype.strategy.OVERFLOW) {
          if (shifted == null) {
            job.doDrop();
          }
          return reachedHWM;
        }
      }
      job.doQueue(reachedHWM, blocked);
      this._queues.push(job);
      await this._drainAll();
      return reachedHWM;
    }

    _receive(job) {
      if (this._states.jobStatus(job.options.id) != null) {
        job._reject(new Bottleneck.prototype.BottleneckError(`A job with the same id already exists (id=${job.options.id})`));
        return false;
      } else {
        job.doReceive();
        return this._submitLock.schedule(this._addToQueue, job);
      }
    }

    submit(...args) {
      var cb, fn, job, options, ref, ref1, task;
      if (typeof args[0] === "function") {
        ref = args, [fn, ...args] = ref, [cb] = splice.call(args, -1);
        options = parser.load({}, this.jobDefaults);
      } else {
        ref1 = args, [options, fn, ...args] = ref1, [cb] = splice.call(args, -1);
        options = parser.load(options, this.jobDefaults);
      }
      task = (...args) => {
        return new this.Promise(function(resolve, reject) {
          return fn(...args, function(...args) {
            return (args[0] != null ? reject : resolve)(args);
          });
        });
      };
      job = new Job(task, args, options, this.jobDefaults, this.rejectOnDrop, this.Events, this._states, this.Promise);
      job.promise.then(function(args) {
        return typeof cb === "function" ? cb(...args) : void 0;
      }).catch(function(args) {
        if (Array.isArray(args)) {
          return typeof cb === "function" ? cb(...args) : void 0;
        } else {
          return typeof cb === "function" ? cb(args) : void 0;
        }
      });
      return this._receive(job);
    }

    schedule(...args) {
      var job, options, task;
      if (typeof args[0] === "function") {
        [task, ...args] = args;
        options = {};
      } else {
        [options, task, ...args] = args;
      }
      job = new Job(task, args, options, this.jobDefaults, this.rejectOnDrop, this.Events, this._states, this.Promise);
      this._receive(job);
      return job.promise;
    }

    wrap(fn) {
      var schedule, wrapped;
      schedule = this.schedule.bind(this);
      wrapped = function(...args) {
        return schedule(fn.bind(this), ...args);
      };
      wrapped.withOptions = function(options, ...args) {
        return schedule(options, fn, ...args);
      };
      return wrapped;
    }

    async updateSettings(options = {}) {
      await this._store.__updateSettings__(parser.overwrite(options, this.storeDefaults));
      parser.overwrite(options, this.instanceDefaults, this);
      return this;
    }

    currentReservoir() {
      return this._store.__currentReservoir__();
    }

    incrementReservoir(incr = 0) {
      return this._store.__incrementReservoir__(incr);
    }

  };

  Bottleneck.default = Bottleneck;

  Bottleneck.Events = Events;

  Bottleneck.version = Bottleneck.prototype.version = require("./version.json").version;

  Bottleneck.strategy = Bottleneck.prototype.strategy = {
    LEAK: 1,
    OVERFLOW: 2,
    OVERFLOW_PRIORITY: 4,
    BLOCK: 3
  };

  Bottleneck.BottleneckError = Bottleneck.prototype.BottleneckError = require("./BottleneckError");

  Bottleneck.Group = Bottleneck.prototype.Group = require("./Group");

  Bottleneck.RedisConnection = Bottleneck.prototype.RedisConnection = require("./RedisConnection");

  Bottleneck.IORedisConnection = Bottleneck.prototype.IORedisConnection = require("./IORedisConnection");

  Bottleneck.Batcher = Bottleneck.prototype.Batcher = require("./Batcher");

  Bottleneck.prototype.jobDefaults = {
    priority: DEFAULT_PRIORITY,
    weight: 1,
    expiration: null,
    id: "<no-id>"
  };

  Bottleneck.prototype.storeDefaults = {
    maxConcurrent: null,
    minTime: 0,
    highWater: null,
    strategy: Bottleneck.prototype.strategy.LEAK,
    penalty: null,
    reservoir: null,
    reservoirRefreshInterval: null,
    reservoirRefreshAmount: null,
    reservoirIncreaseInterval: null,
    reservoirIncreaseAmount: null,
    reservoirIncreaseMaximum: null
  };

  Bottleneck.prototype.localStoreDefaults = {
    Promise: Promise,
    timeout: null,
    heartbeatInterval: 250
  };

  Bottleneck.prototype.redisStoreDefaults = {
    Promise: Promise,
    timeout: null,
    heartbeatInterval: 5000,
    clientTimeout: 10000,
    Redis: null,
    clientOptions: {},
    clusterNodes: null,
    clearDatastore: false,
    connection: null
  };

  Bottleneck.prototype.instanceDefaults = {
    datastore: "local",
    connection: null,
    id: "<no-id>",
    rejectOnDrop: true,
    trackDoneStatus: false,
    Promise: Promise
  };

  Bottleneck.prototype.stopDefaults = {
    enqueueErrorMessage: "This limiter has been stopped and cannot accept new jobs.",
    dropWaitingJobs: true,
    dropErrorMessage: "This limiter has been stopped."
  };

  return Bottleneck;

}).call(this);

module.exports = Bottleneck;
