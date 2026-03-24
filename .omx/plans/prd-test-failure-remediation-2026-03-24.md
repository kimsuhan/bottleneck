# PRD — Remediate remaining test failures on `team/node22-redis-modernization`

Date: 2026-03-24
Mode: $ralplan (consensus, short)
Target branch/worktree: `team/node22-redis-modernization` at `/home/shkim/workspaces/bottleneck-team-exec`

## Requirements Summary

- Explain why the current modernization branch still fails tests.
- Produce a concrete remediation plan, not an implementation.
- Preserve Bottleneck's public clustering behavior where practical.
- Keep the focus on failures introduced or surfaced by the Node 22+/Redis modernization work.

## Grounded Failure Analysis

### Failure bucket 1 — timing-sensitive assertions are too brittle under Redis-backed runs
- `makeTest()` switches the limiter to Redis or ioredis when `DATASTORE` is set (`test/context.js:29-39`) and eagerly kicks off `ready()` (`test/context.js:46-48`), so supposedly “local” tests can still run under Redis-backed load.
- `test/batcher.js:12-43` hard-codes that items 4 and 5 must move into the next 50ms bucket exactly, asserting `[[0,1],[0,2],[0,3],[1,4],[1,5]]`.
- The same test family already accepts broader timing windows elsewhere through `checkDuration()` (`test/context.js:130-138`), so exact bucket edges are stronger than the rest of the suite’s timing model.

Inference: the Batcher failures are likely test-brittleness under heavier event-loop/load conditions, not the first place to infer Redis adapter regressions.

### Failure bucket 2 — node-redis still has a ready/disconnect race in shared/clustered flows
- The modernized `RedisConnection` always chains readiness into script loading (`src/RedisConnection.coffee:26-31`).
- `disconnect()` can still close or destroy clients immediately (`src/RedisConnection.coffee:76-90`, `124-129`).
- Earlier full-suite failures included `ClientClosedError: The client is closed`, which is consistent with teardown racing in-flight ready/script work rather than a pure command-translation bug.
- Targeted Redis reruns passed for a narrowed subset, but full `DATASTORE=redis npm test` still fails outside that subset.

Inference: node-redis parity is improved but incomplete; the remaining failures are likely tied to lifecycle ownership and pubsub/teardown sequencing.

### Failure bucket 3 — the current ioredis failure set mixes harness problems with real adapter parity gaps
- `test/cluster.js:31-35` chooses `client.sendCommand()` whenever that method exists, otherwise `client.call(...)`. That heuristic is suspicious because it assumes method presence is a safe contract discriminator.
- `src/IORedisConnection.coffee:92-104` still does not `await` the first `EVALSHA` path before `catch`, unlike the node-redis adapter (`src/RedisConnection.coffee:110-122`), so async `NOSCRIPT` / connection-state failures can bypass the intended recovery behavior.
- Full `DATASTORE=ioredis npm test` still reports `Connection is closed`, so the ioredis path still needs a real stabilization pass after the harness is cleaned up.

Inference: ioredis is behind the node-redis path, but not all current ioredis failures should be blamed on the adapter until the cluster test helper is fixed.

### Failure bucket 4 — cleanup ownership leaks are contributing noise to the suite
- `Group` starts an autocleanup interval in `src/Group.coffee:62-69`.
- `Group.disconnect()` never clears that interval; it only disconnects the connection when the connection is not shared (`src/Group.coffee:76-79`).

Inference: background cleanup work can survive longer than intended and keep touching limiter stores during teardown, which can amplify connection-closed failures and test contamination.

### Failure bucket 5 — tooling compatibility issues are largely mitigated already
- The branch moved to a Node 22+ baseline (`package.json:7-13`).
- The build script now targets the modern runtime path directly (`scripts/build.sh:16-64`).
- Leak tests were adjusted to skip when the legacy leakage dependency is unavailable (`test/general.js:6-14`, `23-40`).

Inference: the branch is past basic install/build bring-up. The remaining work is mostly semantic and test-harness stabilization.

## Acceptance Criteria

1. Remaining failures are bucketed into:
   - harness/ownership bugs,
   - node-redis lifecycle bugs,
   - ioredis lifecycle bugs,
   - timing-brittle assertions.
2. The remediation plan identifies concrete files and verification commands for each bucket.
3. The plan preserves current public API goals (`datastore`, `ready()`, `clients()`, `publish()`, `disconnect()`) unless an explicit break is documented.
4. Phase checkpoints are explicit and falsifiable:
   - **Phase 0 pass:** cluster helper dispatch, `context` setup/teardown invariant, and `Group.disconnect()` cleanup are fixed; the targeted harness/ownership reruns are green.
   - **Phase 1 pass:** targeted node-redis lifecycle reruns are green and no `ClientClosedError` remains in that subset.
   - **Phase 2 pass:** targeted ioredis reruns are green and no `Connection is closed` remains in that subset.
   - **Phase 3 pass:** timing-only tests are green with documented justification for any threshold changes.
   - **Final pass:** `DATASTORE=redis npm test` and `DATASTORE=ioredis npm test` are both green.

## RALPLAN-DR Summary

### Principles
1. Fix harness and ownership noise before diagnosing deeper adapter behavior.
2. Separate deterministic product regressions from timing-sensitive test brittleness.
3. Keep node-redis and ioredis behavior aligned at the Bottleneck boundary.
4. Recalibrate tests narrowly and only when the semantic contract is unchanged.
5. Prefer targeted reruns to validate a hypothesis before rerunning the full suites.

### Decision Drivers
1. Current failures are mixed-layer failures, not a single adapter bug.
2. Public clustering behavior matters more than perfect internal similarity to legacy clients.
3. Full-suite confidence is the real stop condition; isolated green subsets are insufficient.

### Viable Options
#### Option A — Signal-first triage, then adapter parity, then timing recalibration (Recommended)
- **Approach:** first remove harness/ownership noise (cluster helper dispatch, teardown races, group interval cleanup), then repair remaining adapter parity issues, then relax only justified timing assertions.
- **Pros:** separates false positives from real regressions; reduces the chance of mutating production code to satisfy a broken harness; creates a clearer verification ladder.
- **Cons:** slightly slower than jumping straight into adapter fixes.

#### Option B — Adapter-first stabilization, then test recalibration
- **Approach:** fix node-redis and ioredis lifecycle paths first, then revisit test brittleness.
- **Pros:** keeps the focus on shipped code paths.
- **Cons:** risks chasing harness noise as adapter bugs; less diagnostic clarity.

#### Option C — Shared-contract-first parity pass, then implementation
- **Approach:** define one explicit cross-adapter contract checklist for `ready()`, script loading, subscribe/unsubscribe, disconnect, and missing-data recovery, then repair both adapters against that checklist before touching timing tests.
- **Pros:** strongest long-term symmetry between adapters; reduces piecemeal fixes.
- **Cons:** more upfront design overhead; slower to get the first failing subset green.

#### Invalidation rationale for dropping ioredis support
- Not viable because the modernization scope explicitly preserved `ioredis` for Cluster/Sentinel compatibility and the README/API story still depends on it.

## Cross-Adapter Contract Checklist

Executors should treat these as parity targets for both adapters:
1. `ready()` must not resolve until the command client, subscriber, and initial script-loading path are safe to use.
2. `disconnect(true|false)` must not close a client while `ready()` / initial script loading is still unresolved; teardown must either await setup completion or short-circuit pending setup safely.
3. `__runScript__` must await the first execution attempt and must retry deterministically on `NOSCRIPT`.
4. `subscribe` / `unsubscribe` must only resolve when the limiter mapping is safe to mutate.
5. Missing-data recovery (`SETTINGS_KEY_NOT_FOUND`, `UNKNOWN_CLIENT`) must behave the same for node-redis and ioredis.
6. Shared connections must remain usable after child limiter/group detachment.

## Setup/Teardown Invariant for `test/context.js`

Preferred invariant:
- `makeTest()` should expose a `context.ready` promise (or equivalent settled setup signal), and teardown must wait for setup settlement before calling `disconnect(false)`.
- If teardown wins the race, connection setup/script loading must short-circuit without issuing new commands to closing clients.

This gives executors a concrete target instead of a vague “audit ready kickoff” instruction.

## Implementation Steps

### Phase 0 — Remove harness and lifecycle-ownership noise first
Files:
- `test/cluster.js`
- `test/context.js`
- `src/Group.coffee`
- `src/RedisConnection.coffee`
- `src/IORedisConnection.coffee`

Actions:
1. Replace the `sendCommand`-presence heuristic in `test/cluster.js:31-35` with explicit datastore/client-specific dispatch.
2. Implement the `test/context.js` setup/teardown invariant above for `ready()` and `disconnect(false)`.
3. Clear `Group`’s autocleanup interval during disconnect (`src/Group.coffee:62-69`, `76-79`).
4. Re-run these exact commands:
   - `DATASTORE=redis npx mocha test/cluster.js --grep "Should allow passing a limiter's connection to a new limiter|Should allow passing a limiter's connection to a new Group|Should allow passing a Group's connection to a new limiter"`
   - `DATASTORE=ioredis npx mocha test/cluster.js --grep "Should not have a key TTL by default for standalone limiters|Should allow timeout setting for standalone limiters|Should migrate from 2.8.0|Should keep track of each client's queue length"`
   - `DATASTORE=ioredis npx mocha test/group.js --grep "Should create limiters|Should call autocleanup"`

Success check:
- The harness/ownership subsets above are green.

### Phase 1 — Finish node-redis lifecycle parity
Files:
- `src/RedisConnection.coffee`
- `src/RedisDatastore.coffee`
- `test/node_redis.js`
- `test/cluster.js`

Actions:
1. Audit subscription readiness and shared-connection unsubscribe teardown in `src/RedisConnection.coffee:96-108`.
2. Enforce the disconnect rule that no client is closed while `ready()` / `_loadScripts()` is unresolved (`src/RedisConnection.coffee:26-31`, `76-90`, `124-129`).
3. Re-check `NOSCRIPT` recovery and script execution sequencing in `src/RedisConnection.coffee:110-122` and datastore recovery handling in `src/RedisDatastore.coffee:72-95`.
4. Re-run these exact commands:
   - `DATASTORE=redis npx mocha test/node_redis.js`
   - `DATASTORE=redis npx mocha test/cluster.js --grep "Should allow passing a limiter's connection to a new limiter|Should allow passing a limiter's connection to a new Group|Should migrate from 2.8.0|Should not fail when Redis data is missing|Should publish capacity increases|Should publish capacity changes on reservoir changes"`

Success check:
- These targeted node-redis commands are green and emit no `ClientClosedError`.

### Phase 2 — Bring ioredis to the same contract
Files:
- `src/IORedisConnection.coffee`
- `src/RedisDatastore.coffee`
- `test/ioredis.js`
- `test/cluster.js`

Actions:
1. Mirror the awaited script-execution / retry structure used by node-redis in `src/IORedisConnection.coffee:92-104`.
2. Audit subscriber readiness, cluster subscriber creation, and disconnect behavior in `src/IORedisConnection.coffee:21-39`, `41-52`, `66-73`, `79-111` against the shared contract checklist.
3. Re-run these exact commands:
   - `DATASTORE=ioredis npx mocha test/ioredis.js`
   - `DATASTORE=ioredis npx mocha test/cluster.js --grep "Should allow passing a limiter's connection to a new limiter|Should allow passing a limiter's connection to a new Group|Should allow passing a Group's connection to a new limiter|Should not fail when Redis data is missing|Should publish capacity increases|Should publish capacity changes on reservoir changes"`

Success check:
- These targeted ioredis commands are green and emit no `Connection is closed`.

### Phase 3 — Recalibrate timing-brittle tests narrowly
Files:
- `test/batcher.js`
- `test/context.js`
- `test/general.js`

Actions:
1. Rework the Batcher assertions in `test/batcher.js:33-42` to emphasize ordering and batch shape over exact 50ms boundary placement.
2. Keep semantic assertions strict; widen timing windows only where the underlying product behavior is unchanged.
3. Re-run these exact commands:
   - `npx mocha test/batcher.js`
   - `npx mocha test/general.js --grep "Reservoir Refresh|Reservoir Increase"`

Success check:
- These timing-focused commands are green with documented reasons for any widened window.

### Phase 4 — Full regression and evidence freeze
Commands:
- `./scripts/build.sh`
- `npm test`
- `DATASTORE=redis npm test`
- `DATASTORE=ioredis npm test`

Actions:
1. Run targeted subsets after each phase.
2. Run `npm test` as a local baseline.
3. Run the full Redis suite.
4. Run the full ioredis suite.
5. Capture exact residual evidence if anything remains failing; otherwise freeze the branch.

Success check:
- Both datastore suites pass, or any remaining skipped/recalibrated tests are explicitly justified.

## Risks and Mitigations

- **Risk:** time-based test recalibration could hide a real scheduling regression.  
  **Mitigation:** gate any test relaxation behind green targeted adapter/lifecycle reruns; verify again with `npx mocha test/batcher.js` and `npx mocha test/general.js --grep "Reservoir Refresh|Reservoir Increase"`.

- **Risk:** fixing node-redis first could drift the ioredis contract further.  
  **Mitigation:** use the shared cross-adapter checklist and require the explicit ioredis targeted reruns in Phase 2.

- **Risk:** worker-era partial merges may still leave inconsistent assumptions in the branch.  
  **Mitigation:** consolidate verification in one worktree and preserve one captured failure ledger before the next fix pass.

## Verification Steps

1. Re-run the harness/ownership subsets in Phase 0.
2. Re-run the node-redis targeted subsets in Phase 1.
3. Re-run the ioredis targeted subsets in Phase 2.
4. Re-run the timing-focused subsets in Phase 3.
5. Re-run `./scripts/build.sh`, `npm test`, `DATASTORE=redis npm test`, and `DATASTORE=ioredis npm test` in Phase 4.
6. Only mark the branch stable once the full suites are green.

## ADR

- **Decision:** Use Option A — signal-first triage, then adapter parity, then timing recalibration.
- **Drivers:** cleaner diagnosis, stronger compatibility story, fewer false-positive adapter edits.
- **Alternatives considered:** adapter-first stabilization; shared-contract-first parity pass; reducing ioredis scope.
- **Why chosen:** it best separates harness noise from true lifecycle bugs before committing to deeper code changes while still preserving a clear path into adapter parity.
- **Consequences:** an extra cleanup phase now, but higher confidence and less wasted churn later.
- **Follow-ups:** once the suites are green, run a final review pass on the Redis adapters and release-note any justified test recalibration.

## Available-Agent-Types Roster
- `executor`
- `debugger`
- `test-engineer`
- `architect`
- `critic`
- `verifier`
- `code-reviewer`

## Follow-up Staffing Guidance

### Ralph path
- `debugger` (high): root-cause and isolate lifecycle races.
- `executor` (high): apply harness/adapter fixes in `src/` and `test/`.
- `test-engineer` (medium): own targeted/full reruns and evidence capture.
- `architect` (medium): final contract review before closure.

Launch hint:
- `$ralph fix the remaining redis/ioredis suite failures on team/node22-redis-modernization using .omx/plans/prd-test-failure-remediation-2026-03-24.md`

### Team path
- 1 × `debugger` (high) — harness/lifecycle triage
- 1 × `executor` (high) — source and test fixes
- 1 × `test-engineer` (medium) — targeted/full reruns
- 1 × `verifier` (high) — final evidence capture

Launch hint:
- `omx team 4:executor "Stabilize remaining Redis/ioredis failures per .omx/plans/prd-test-failure-remediation-2026-03-24.md"`

### Team Verification Path
- Team proves: targeted subsets for harness, Redis, and ioredis are green and both full datastore suites were rerun.
- Ralph or leader verifies after handoff: final `npm test`, `DATASTORE=redis npm test`, and `DATASTORE=ioredis npm test` evidence is green before closing the branch.

## Iteration changelog
- Added a stronger third option (`shared-contract-first parity pass`).
- Added explicit setup/teardown invariants for `test/context.js`.
- Added an explicit cross-adapter contract checklist.
- Replaced vague reruns with exact commands by phase.
- Tightened acceptance criterion 4 into phase-level checkpoints.
