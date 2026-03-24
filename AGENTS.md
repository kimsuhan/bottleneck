# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the CoffeeScript source for Bottleneck, including Redis Lua scripts in `src/redis/`.
- `lib/` contains generated runtime files; `es5.js`, `light.js`, `bottleneck.d.ts`, and `light.d.ts` are build outputs.
- `test/` holds Mocha coverage by feature (`bottleneck.js`, `group.js`, `priority.js`, etc.), plus spawned-process fixtures under `test/spawn/`.
- `scripts/` contains build helpers such as `build.sh`, `assemble_lua.js`, and `version.js`.
- Edit `src/` and supporting templates, not generated files in `lib/`.

## Build, Test, and Development Commands
- `npm test` — run the default Mocha suite against `lib/index.js`.
- `./scripts/build.sh dev` — fast local rebuild for Node 10+ development.
- `./scripts/build.sh` — full build: ES5 bundle, light bundle, Node 6 build, and TypeScript declaration checks.
- `./scripts/build.sh typings` — regenerate `.d.ts` files and validate them with `tsc --noEmit --strict`.
- `npm run test-all` — run local, Redis, ioredis, ES5, and light-build tests. Requires a local Redis server and `.env` values when using non-default host/port.

## Coding Style & Naming Conventions
- Follow existing CoffeeScript style in `src/`: 2-space indentation, small focused modules, and concise method names.
- Use PascalCase for class files (`Batcher.coffee`, `RedisConnection.coffee`) and lowercase test filenames (`group.js`, `retries.js`).
- Keep generated artifacts consistent by rebuilding after source changes.
- There is no dedicated lint config in this repo; match the surrounding file’s formatting and quote style.

## Testing Guidelines
- Tests use Mocha with Node’s assertion patterns and environment switches such as `BUILD=es5` or `DATASTORE=ioredis`.
- Add or update the closest feature test file in `test/` when changing behavior.
- For Redis-related work, verify both `redis` and `ioredis` paths with `npm run test-all` before opening a PR.

## Commit & Pull Request Guidelines
- Recent history uses short, imperative subjects, sometimes with a scope prefix (for example, `types: add type definitions for bottleneck/light`).
- Keep commit messages specific to intent, and group generated output with its source change.
- PRs should explain the behavior change, list verification performed, link related issues, and note Redis or bundle impact when relevant.
