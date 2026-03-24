var DLList, Sync;

DLList = require("./DLList");

Sync = class Sync {
  constructor(name, Promise) {
    this.schedule = this.schedule.bind(this);
    this.name = name;
    this.Promise = Promise;
    this._running = 0;
    this._queue = new DLList();
  }

  isEmpty() {
    return this._queue.length === 0;
  }

  async _tryToRun() {
    var args, cb, error, reject, resolve, returned, task;
    if ((this._running < 1) && this._queue.length > 0) {
      this._running++;
      ({task, args, resolve, reject} = this._queue.shift());
      cb = (await (async function() {
        try {
          returned = (await task(...args));
          return function() {
            return resolve(returned);
          };
        } catch (error1) {
          error = error1;
          return function() {
            return reject(error);
          };
        }
      })());
      this._running--;
      this._tryToRun();
      return cb();
    }
  }

  schedule(task, ...args) {
    var promise, reject, resolve;
    resolve = reject = null;
    promise = new this.Promise(function(_resolve, _reject) {
      resolve = _resolve;
      return reject = _reject;
    });
    this._queue.push({task, args, resolve, reject});
    this._tryToRun();
    return promise;
  }

};

module.exports = Sync;
