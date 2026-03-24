if (process.env.BUILD === 'es5') {
  module.exports = require('../es5.js')
} else if (process.env.BUILD === 'light') {
  module.exports = require('../light.js')
} else {
  module.exports = require('../lib/index.js')
}

if (process.env.DATASTORE === 'redis' || process.env.DATASTORE === 'ioredis') {
  var workerScope = (process.env.OMX_TEAM_WORKER || 'worker').replace(/[\\/]/g, '-')
  var testScope = process.pid + '-' + workerScope
  module.exports.prototype.instanceDefaults.id = '<no-id>-' + testScope
}
