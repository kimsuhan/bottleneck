var assert = require('assert')
var Scripts = require('../lib/Scripts.js')

describe('Scripts', function () {
  it('Should colocate all keys for one logical id in the same cluster slot tag', function () {
    var keys = Scripts.allKeys('group-key-user:1')
    var slotTags = keys.map(function (key) {
      var match = key.match(/\{([^}]+)\}/)
      return match && match[1]
    })

    assert(slotTags.every(Boolean))
    assert.deepStrictEqual(new Set(slotTags).size, 1)
  })

  it('Should preserve the logical id through the settings-key parser', function () {
    var logicalId = 'group-key-user:1'
    var settingsKey = Scripts.settingsKey(logicalId)
    assert.strictEqual(Scripts.parseId(settingsKey), logicalId)
  })

  it('Should version the pubsub channels with the same slot tag', function () {
    var logicalId = 'group-key-user:1'
    var channel = Scripts.channel(logicalId)
    var clientChannel = Scripts.channelClient(logicalId, 'client-123')
    var channelTag = channel.match(/\{([^}]+)\}/)
    var clientChannelTag = clientChannel.match(/\{([^}]+)\}/)

    assert(channelTag)
    assert(clientChannelTag)
    assert.strictEqual(channelTag[1], clientChannelTag[1])
  })
})
