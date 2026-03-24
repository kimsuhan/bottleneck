# PRD — Bottleneck Node 22+ modernization with Redis connection focus

Date: 2026-03-24
Mode: $plan (direct after brief interview)
Decision: Compatibility-first modernization, with Node 22+ as the new runtime baseline

## Requirements Summary

### User intent
- Modernize a project that has effectively been dormant for ~6 years.
- Prioritize the Redis connection layer.
- Keep Bottleneck's public behavior as stable as practical.
- Raise the runtime baseline to Node 22+ rather than preserving Node 6/10/ES5 support.

### Codebase facts grounding this plan
- The current package still pins very old Redis clients: `redis ^2.8.0` and `ioredis ^4.11.1` (`package.json:36-53`).
- The current node-redis adapter is built around the legacy callback API: `createClient`, `ready`, `multi(...).exec_atomic`, and `end()` (`src/RedisConnection.coffee:20-27`, `29-53`, `82-88`).
- The ioredis adapter is built around old constructor and shutdown assumptions, but its overall abstraction still matches the current Bottleneck design better than node-redis cluster support would (`src/IORedisConnection.coffee:21-34`, `46-82`).
- Bottleneck exposes Redis connection classes publicly (`src/Bottleneck.coffee:20-21`) and Group internally creates them based on `datastore` (`src/Group.coffee:22-26`).
- The cluster test suite directly reaches into raw client methods in callback style, especially `client[command](...args, cb)` (`test/cluster.js:18-25`), so tests themselves are part of the modernization surface.
- README still documents Node 6+, old NodeRedis links, and old connection examples (`README.md:176`, `765-958`, `984`).

### External constraints / current ecosystem facts
- As of 2026-03-24, official node-redis docs show the current model as `createClient().connect()` with `close()/destroy()` replacing older shutdown semantics, and document active maintenance: https://github.com/redis/node-redis
- As of 2026-03-24, the official ioredis README says maintenance is best-effort and recommends node-redis for new projects, while still advertising Cluster and Sentinel support that Bottleneck currently depends on for `clusterNodes`: https://github.com/redis/ioredis

## Scope

### In scope
1. Raise Bottleneck's supported runtime baseline to Node 22+.
2. Modernize the `redis` datastore path to the current node-redis API.
3. Preserve the existing Bottleneck-facing clustering API shape where feasible:
   - `datastore: "redis" | "ioredis"`
   - `ready()`
   - `clients()`
   - `publish()`
   - `disconnect(flush)`
   - shared `connection` injection / reuse semantics
4. Keep `ioredis` support for the capabilities Bottleneck currently documents as ioredis-only (`clusterNodes`, Sentinel-oriented usage).
5. Rewrite/update tests and docs to match the new runtime and client APIs.
6. Refresh build/tooling assumptions so the repo no longer targets Node 6/10/ES5 compatibility artifacts by default.

### Out of scope for this pass
- Changing Bottleneck’s Lua scheduling semantics.
- Replacing Redis as the clustering backend.
- Large public API redesign of limiter/group behavior outside Redis integration.
- Promise/callback normalization across the entire library beyond what Node 22+ modernization requires.
- Adding new dependencies unless unavoidable.

## Non-goals / compatibility boundaries
- Do **not** preserve raw node-redis v2 client behavior returned from `clients()`. Returning a modern node-redis client object is acceptable, even if downstream callers who poked old callback methods need migration.
- Do **not** preserve Node 6/10/ES5 build output promises; this plan intentionally drops that support.
- Do **not** collapse `ioredis` support into `redis` if that would remove documented Cluster/Sentinel workflows.

## Acceptance Criteria

1. **Runtime baseline updated**
   - `package.json` and README clearly state Node 22+.
   - Legacy Node 6/10/ES5 build claims are removed or replaced.

2. **Modern node-redis integration works**
   - `datastore: "redis"` uses the latest supported `redis` package API.
   - Creating a limiter with Bottleneck-managed clients succeeds.
   - Passing a prebuilt modern node-redis client into `new Bottleneck.RedisConnection({ client })` succeeds.
   - Shared connection reuse between limiter/group instances still works.

3. **ioredis compatibility remains intact**
   - `datastore: "ioredis"` still works for standalone limiter usage.
   - `clusterNodes` still creates a functioning ioredis cluster-backed connection.
   - Existing connection reuse semantics still work for ioredis.

4. **Cluster behavior contract remains stable**
   - Redis-backed `ready()`, `clients()`, `publish()`, and `disconnect()` still behave according to README-level promises.
   - Redis-backed cluster tests pass after adapting them away from legacy callback-only raw client access.

5. **Documentation is current**
   - README clustering examples reference the modern node-redis API and the correct ioredis positioning.
   - Migration notes call out the biggest breaking changes: Node 22+ baseline, modern raw node-redis clients from `clients()`, and updated disconnect semantics.

6. **Verification is automated**
   - Local tests cover both `DATASTORE=redis` and `DATASTORE=ioredis` paths.
   - Type/packaging/build checks relevant to the new baseline pass.

## Implementation Strategy

### Chosen approach
Keep Bottleneck’s public clustering API stable while refactoring the **internal connection boundary** to adapt old Redis client assumptions to modern client APIs.

### Why this approach
- The risky part is not only package bumps; it is the implicit adapter contract between `RedisDatastore` and the connection classes.
- `RedisDatastore` currently assumes callback-style script execution and generic command dispatch (`src/RedisDatastore.coffee:68-81`). Modern node-redis favors async methods and structured command invocation.
- A small internal adapter cleanup reduces future Redis-client churn without forcing a broad public API rewrite.

### Rejected alternative
- **Direct package bump with minimal code edits:** rejected because `src/RedisConnection.coffee` is tightly coupled to removed legacy node-redis behaviors (`exec_atomic`, `end`, implicit ready state) and tests also rely on callback-era raw client access.

## Implementation Steps

### Phase 1 — Reset the runtime/tooling baseline
Files:
- `package.json`
- `package-lock.json`
- `scripts/build.sh`
- `README.md`
- possibly CI metadata if present

Tasks:
1. Raise `engines.node` / package documentation to Node 22+.
2. Replace old Redis dependency versions with modern supported versions.
3. Remove or simplify build steps that only exist for Node 6/10/ES5 compatibility.
4. Rebuild the generated `lib/` outputs against the new baseline.

Exit criteria:
- Repo no longer claims Node 6+/10+ compatibility.
- Install/build steps target the modern runtime only.

### Phase 2 — Introduce a modern internal Redis connection contract
Files:
- `src/RedisConnection.coffee`
- `src/IORedisConnection.coffee`
- `src/RedisDatastore.coffee`
- possibly `src/Group.coffee`

Tasks:
1. Define the minimal internal operations Bottleneck actually needs from a connection:
   - create/connect two clients
   - subscribe/unsubscribe channels
   - generic command dispatch for `scan` / `del`
   - script load / script execute
   - publish
   - disconnect/close semantics
2. Refactor `RedisDatastore` to depend on those normalized operations instead of callback-specific calling conventions.
3. Keep the public class names (`RedisConnection`, `IORedisConnection`) unchanged.

Exit criteria:
- `RedisDatastore` no longer depends on callback-only transport details.
- Both connection classes satisfy the same internal contract.

### Phase 3 — Rewrite the node-redis adapter for the modern API
Files:
- `src/RedisConnection.coffee`
- `test/node_redis.js`
- `test/cluster.js`

Tasks:
1. Replace legacy `createClient` assumptions with explicit async connection setup.
2. Update ready detection from `client.ready` to modern connected/ready signals.
3. Replace `multi(...).exec_atomic` usage with a modern generic command path.
4. Replace `SCRIPT LOAD` + `evalsha` callback flow with async modern script-loading/execution.
5. Map `disconnect(flush)` onto modern client shutdown behavior and document the exact semantics.
6. Update tests that assert old raw client internals (`client.ready`, callback command signatures).

Exit criteria:
- Redis datastore passes Bottleneck’s standalone and cluster tests using the modern `redis` package.
- Shared connection reuse still works.

### Phase 4 — Tighten ioredis support around the new baseline
Files:
- `src/IORedisConnection.coffee`
- `test/ioredis.js`
- `test/cluster.js`
- `README.md`

Tasks:
1. Keep ioredis support for Cluster/Sentinel-oriented workflows.
2. Verify cluster-mode client creation and duplicate/subscriber handling under the modernized internal contract.
3. Normalize disconnect and script execution behavior to match the refactored `RedisDatastore` contract.
4. Update docs to explicitly position ioredis as the compatibility path for Bottleneck’s cluster/sentinel features rather than the default recommendation for new general Redis usage.

Exit criteria:
- `DATASTORE=ioredis` passes standalone and cluster-focused suites.
- `clusterNodes` behavior remains documented and tested.

### Phase 5 — Rewrite tests around public guarantees, not legacy client internals
Files:
- `test/context.js`
- `test/cluster.js`
- `test/node_redis.js`
- `test/ioredis.js`
- any affected helper tests

Tasks:
1. Replace callback-style raw command helper logic in `test/cluster.js:18-25` with an adapter that works with both modern node-redis and ioredis.
2. Prefer asserting Bottleneck guarantees (`ready`, `clients`, `publish`, connection reuse, cleanup) over implementation details like `client.ready === true`.
3. Add focused regression tests for:
   - shared connection lifecycle
   - limiter/group connection reuse
   - script reloading after `SETTINGS_KEY_NOT_FOUND`
   - disconnect behavior with `flush=true/false`
4. If needed, split Redis-integration tests into clearer capability groups.

Exit criteria:
- The tests describe Bottleneck behavior instead of the exact callback API of legacy clients.

### Phase 6 — Refresh docs and migration guidance
Files:
- `README.md`
- changelog / release notes file if maintained

Tasks:
1. Rewrite clustering examples using modern client setup.
2. Update old NodeRedis and ioredis links.
3. Document Node 22+ baseline.
4. Add a migration note for users who access raw clients via `clients()`.
5. Clarify that Cluster/Sentinel support remains under `ioredis`, while standard Redis usage uses the modern node-redis implementation.

Exit criteria:
- README no longer advertises stale APIs or runtime support.

## Risks and Mitigations

### Risk 1 — Hidden breakage for users of `clients()`
Why it matters:
- `clients()` intentionally exposes raw clients (`README.md:897-903`), and those raw objects will necessarily change shape after a node-redis major upgrade.

Mitigation:
- Treat this as an explicit breaking change in migration notes.
- Keep Bottleneck-level methods stable even if raw client ergonomics change.
- Prefer semver-major release framing for the modernization branch.

### Risk 2 — Script execution mismatch between redis and ioredis
Why it matters:
- `RedisDatastore.runScript()` currently depends on a callback-style `__scriptFn__/__scriptArgs__` handshake (`src/RedisDatastore.coffee:68-81`).

Mitigation:
- Collapse script invocation behind a single async adapter boundary.
- Add regression tests for `init`, `register_client`, `heartbeat`, and recovery flows.

### Risk 3 — Disconnect semantics drift
Why it matters:
- Old node-redis used `.end()`, modern docs emphasize `close()/destroy()`.
- Existing Bottleneck API already exposes `disconnect(flush=true)`.

Mitigation:
- Define flush semantics explicitly in docs and tests.
- Verify both shared-connection and owned-connection shutdown paths.

### Risk 4 — ioredis maintenance posture
Why it matters:
- Official ioredis README now describes best-effort maintenance while recommending node-redis for new projects.

Mitigation:
- Keep ioredis only where Bottleneck still needs its feature coverage (cluster/sentinel compatibility).
- Avoid deep new feature investment in the ioredis path beyond compatibility and tests.

### Risk 5 — Build output drift from editing `src/` only
Why it matters:
- This repo edits CoffeeScript in `src/` and generates runtime artifacts into `lib/`.

Mitigation:
- Every source change must be followed by the appropriate build/regeneration step before verification.

## Verification Steps

### Fast verification during implementation
1. Build the library from `src/` into `lib/`.
2. Run the base non-Redis test suite.
3. Run targeted Redis integration tests for each adapter separately.

### Required pre-completion verification
1. `npm test`
2. `DATASTORE=redis npm test` or the repo’s equivalent targeted command set for redis-backed tests
3. `DATASTORE=ioredis npm test` or the repo’s equivalent targeted command set for ioredis-backed tests
4. Full build/regeneration for the Node 22+ baseline
5. Any typing checks still supported by the repo after tooling refresh

### Evidence expected before claiming completion
- Passing test output for local suite
- Passing redis-backed suite
- Passing ioredis-backed suite
- Regenerated build artifacts committed together with source/doc changes

## Recommended Execution Order
1. Runtime baseline and dependency bump
2. Internal Redis adapter contract cleanup
3. Modern node-redis migration
4. ioredis normalization
5. Test modernization
6. Docs + migration notes
7. Full verification

## Suggested implementation slices
- Slice A: runtime + docs baseline cleanup
- Slice B: connection adapter refactor
- Slice C: node-redis migration
- Slice D: ioredis compatibility pass
- Slice E: cluster/integration test rewrite

These slices can overlap, but Slice B is the main dependency for C/D/E.

## Definition of Done
- Node 22+ is the documented and tested baseline.
- Redis integration works with current node-redis.
- ioredis support remains for Bottleneck’s documented cluster/sentinel path.
- Public Bottleneck clustering semantics remain stable at the README/API level.
- Tests and docs no longer encode legacy Redis client assumptions.
