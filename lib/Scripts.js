var KEY_PREFIX, KEY_SUFFIXES, KEY_VERSION, headers, lua, templates;

lua = require("./lua.json");

headers = {
  refs: lua["refs.lua"],
  validate_keys: lua["validate_keys.lua"],
  validate_client: lua["validate_client.lua"],
  refresh_expiration: lua["refresh_expiration.lua"],
  process_tick: lua["process_tick.lua"],
  conditions_check: lua["conditions_check.lua"],
  get_time: lua["get_time.lua"]
};

KEY_VERSION = "v3";

KEY_PREFIX = `b_${KEY_VERSION}`;

KEY_SUFFIXES = ["settings", "job_weights", "job_expirations", "job_clients", "client_running", "client_num_queued", "client_last_registered", "client_last_seen"];

exports.keyVersion = function() {
  return KEY_VERSION;
};

exports.encodeId = function(id) {
  return encodeURIComponent(`${id}`);
};

exports.decodeId = function(id) {
  return decodeURIComponent(`${id}`);
};

exports.slotTag = function(id) {
  return exports.encodeId(id);
};

exports.baseKey = function(id) {
  return `${KEY_PREFIX}:{${exports.slotTag(id)}}`;
};

exports.dataKey = function(id, suffix) {
  return `${exports.baseKey(id)}:${suffix}`;
};

exports.settingsKey = function(id) {
  return exports.dataKey(id, "settings");
};

exports.settingsPattern = function() {
  return `${KEY_PREFIX}:{*}:settings`;
};

exports.parseId = function(key) {
  var match;
  match = key.match(/^b_v3:\{([^}]+)\}:settings$/);
  if (match == null) {
    throw new Error(`Invalid settings key: ${key}`);
  }
  return exports.decodeId(match[1]);
};

exports.channel = function(id) {
  return `${exports.baseKey(id)}:channel`;
};

exports.channelClient = function(id, clientId) {
  return `${exports.channel(id)}:${clientId}`;
};

exports.allKeys = function(id) {
  /*
  HASH
  */
  /*
  HASH
  job index -> weight
  */
  /*
  ZSET
  job index -> expiration
  */
  /*
  HASH
  job index -> client
  */
  /*
  ZSET
  client -> sum running
  */
  /*
  HASH
  client -> num queued
  */
  /*
  ZSET
  client -> last job registered
  */
  /*
  ZSET
  client -> last seen
  */
  return [exports.dataKey(id, "settings"), exports.dataKey(id, "job_weights"), exports.dataKey(id, "job_expirations"), exports.dataKey(id, "job_clients"), exports.dataKey(id, "client_running"), exports.dataKey(id, "client_num_queued"), exports.dataKey(id, "client_last_registered"), exports.dataKey(id, "client_last_seen")];
};

templates = {
  init: {
    keys: exports.allKeys,
    headers: ["process_tick"],
    refresh_expiration: true,
    code: lua["init.lua"]
  },
  group_check: {
    keys: exports.allKeys,
    headers: [],
    refresh_expiration: false,
    code: lua["group_check.lua"]
  },
  register_client: {
    keys: exports.allKeys,
    headers: ["validate_keys"],
    refresh_expiration: false,
    code: lua["register_client.lua"]
  },
  blacklist_client: {
    keys: exports.allKeys,
    headers: ["validate_keys", "validate_client"],
    refresh_expiration: false,
    code: lua["blacklist_client.lua"]
  },
  heartbeat: {
    keys: exports.allKeys,
    headers: ["validate_keys", "validate_client", "process_tick"],
    refresh_expiration: false,
    code: lua["heartbeat.lua"]
  },
  update_settings: {
    keys: exports.allKeys,
    headers: ["validate_keys", "validate_client", "process_tick"],
    refresh_expiration: true,
    code: lua["update_settings.lua"]
  },
  running: {
    keys: exports.allKeys,
    headers: ["validate_keys", "validate_client", "process_tick"],
    refresh_expiration: false,
    code: lua["running.lua"]
  },
  queued: {
    keys: exports.allKeys,
    headers: ["validate_keys", "validate_client"],
    refresh_expiration: false,
    code: lua["queued.lua"]
  },
  done: {
    keys: exports.allKeys,
    headers: ["validate_keys", "validate_client", "process_tick"],
    refresh_expiration: false,
    code: lua["done.lua"]
  },
  check: {
    keys: exports.allKeys,
    headers: ["validate_keys", "validate_client", "process_tick", "conditions_check"],
    refresh_expiration: false,
    code: lua["check.lua"]
  },
  submit: {
    keys: exports.allKeys,
    headers: ["validate_keys", "validate_client", "process_tick", "conditions_check"],
    refresh_expiration: true,
    code: lua["submit.lua"]
  },
  register: {
    keys: exports.allKeys,
    headers: ["validate_keys", "validate_client", "process_tick", "conditions_check"],
    refresh_expiration: true,
    code: lua["register.lua"]
  },
  free: {
    keys: exports.allKeys,
    headers: ["validate_keys", "validate_client", "process_tick"],
    refresh_expiration: true,
    code: lua["free.lua"]
  },
  current_reservoir: {
    keys: exports.allKeys,
    headers: ["validate_keys", "validate_client", "process_tick"],
    refresh_expiration: false,
    code: lua["current_reservoir.lua"]
  },
  increment_reservoir: {
    keys: exports.allKeys,
    headers: ["validate_keys", "validate_client", "process_tick"],
    refresh_expiration: true,
    code: lua["increment_reservoir.lua"]
  }
};

exports.names = Object.keys(templates);

exports.keys = function(name, id) {
  return templates[name].keys(id);
};

exports.payload = function(name) {
  var template;
  template = templates[name];
  return Array.prototype.concat(headers.refs, template.headers.map(function(h) {
    return headers[h];
  }), (template.refresh_expiration ? headers.refresh_expiration : ""), template.code).join("\n");
};
