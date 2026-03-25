# Test Spec — Node 22+ Redis modernization

Date: 2026-03-24
Related plan: `.omx/plans/prd-node22-redis-modernization-2026-03-24.md`

## Test goals
1. Prove Bottleneck still works locally after dropping legacy runtime targets.
2. Prove `datastore: "redis"` works with the modern node-redis client.
3. Prove `datastore: "ioredis"` still works, especially for cluster-oriented setup and connection reuse.
4. Prove docs-visible methods (`ready`, `clients`, `publish`, `disconnect`) still behave correctly.

## Test matrix

### A. Local / non-Redis baseline
- Run the default suite under Node 22+.
- Confirm generated artifacts still load from `lib/`.

### B. node-redis adapter
Cover at minimum:
- limiter initializes with managed modern `redis` client
- shared `Bottleneck.RedisConnection` works across multiple limiters/groups
- externally supplied modern `redis` client works
- `ready()` resolves after connection setup
- `clients()` returns `{ client, subscriber }`
- `publish()` delivers messages across limiters
- `disconnect(true)` and `disconnect(false)` both behave as documented
- script load / reload path works after datastore clear or missing settings

### C. ioredis adapter
Cover at minimum:
- limiter initializes with managed `ioredis` client
- shared `Bottleneck.IORedisConnection` works
- externally supplied `ioredis` client works
- `clusterNodes` path still initializes
- `ready()` / `clients()` / `publish()` / `disconnect()` remain good

### D. Cluster / group integration
Cover at minimum:
- limiter-to-limiter shared connection reuse
- group-to-limiter shared connection reuse
- group-to-group shared connection reuse
- key cleanup and TTL-related behavior
- cluster-wide queue/running state invariants already covered by the suite

## Required test updates

### Replace legacy helper assumptions
Current issue:
- `test/cluster.js:18-25` assumes callback-form raw client commands.

Update plan:
- introduce a helper that can issue `del`, `exists`, `ttl`, `scan`, and similar commands through both modern node-redis and ioredis
- keep helper logic in tests only; do not couple production code to test shims

### Add regressions for migration-sensitive behavior
Add tests for:
- modern node-redis shared client injection
- connection shutdown semantics when Bottleneck owns the client vs shares it
- raw `clients()` object is accessible even if its client API shape changed
- script reinitialization when Redis state is missing

## Verification commands to wire up during execution
Exact commands may change with tooling cleanup, but completion should include equivalents of:
- `npm test`
- Redis-backed targeted tests
- ioredis-backed targeted tests
- full build/regeneration
- typings/typecheck if retained

## Pass/Fail criteria
- PASS only if all local + redis + ioredis suites pass on Node 22+
- FAIL if Redis behavior works only for one adapter
- FAIL if README still documents stale client/runtime expectations
- FAIL if tests still depend on removed callback-only node-redis APIs
