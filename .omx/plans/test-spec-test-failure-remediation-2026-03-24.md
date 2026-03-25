# Test Spec — Remaining failure remediation on `team/node22-redis-modernization`

Related PRD: `.omx/plans/prd-test-failure-remediation-2026-03-24.md`

## Goal
Turn the current partially-green modernization branch into a fully green branch for local, redis, and ioredis suites.

## Verification ladder
1. `./scripts/build.sh`
2. `npm test`
3. Phase-0 targeted harness/ownership reruns
4. Phase-1 targeted node-redis reruns
5. Phase-2 targeted ioredis reruns
6. Phase-3 timing-focused reruns
7. `DATASTORE=redis npm test`
8. `DATASTORE=ioredis npm test`

## Phase-specific commands
### Phase 0
- `DATASTORE=redis npx mocha test/cluster.js --grep "Should allow passing a limiter's connection to a new limiter|Should allow passing a limiter's connection to a new Group|Should allow passing a Group's connection to a new limiter"`
- `DATASTORE=ioredis npx mocha test/cluster.js --grep "Should not have a key TTL by default for standalone limiters|Should allow timeout setting for standalone limiters|Should migrate from 2.8.0|Should keep track of each client's queue length"`
- `DATASTORE=ioredis npx mocha test/group.js --grep "Should create limiters|Should call autocleanup"`

### Phase 1
- `DATASTORE=redis npx mocha test/node_redis.js`
- `DATASTORE=redis npx mocha test/cluster.js --grep "Should allow passing a limiter's connection to a new limiter|Should allow passing a limiter's connection to a new Group|Should migrate from 2.8.0|Should not fail when Redis data is missing|Should publish capacity increases|Should publish capacity changes on reservoir changes"`

### Phase 2
- `DATASTORE=ioredis npx mocha test/ioredis.js`
- `DATASTORE=ioredis npx mocha test/cluster.js --grep "Should allow passing a limiter's connection to a new limiter|Should allow passing a limiter's connection to a new Group|Should allow passing a Group's connection to a new limiter|Should not fail when Redis data is missing|Should publish capacity increases|Should publish capacity changes on reservoir changes"`

### Phase 3
- `npx mocha test/batcher.js`
- `npx mocha test/general.js --grep "Reservoir Refresh|Reservoir Increase"`

## Minimum evidence required
- No `ClientClosedError` on the node-redis path
- No `Connection is closed` failures on the ioredis path
- No lingering group autocleanup activity after disconnect
- Any timing-threshold changes are justified by stable semantic assertions
- Full redis and ioredis suites pass
