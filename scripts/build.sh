#!/usr/bin/env bash

set -euo pipefail

if [ ! -d node_modules ]; then
  echo "[B] Run 'npm install' first"
  exit 1
fi

clean() {
  rm -rf lib/*
  node scripts/version.js > lib/version.json
  node scripts/assemble_lua.js > lib/lua.json
}

makeLib() {
  echo '[B] Compiling Bottleneck for Node 22+...'
  npx coffee --compile --bare --no-header src/*.coffee
  mv src/*.js lib/
}

makeLight() {
  echo '[B] Assembling light bundle...'
  npx rollup -c rollup.config.light.js
}

makeTypings() {
  echo '[B] Compiling and testing TS typings...'
  npx ejs-cli bottleneck.d.ts.ejs > bottleneck.d.ts
  npx ejs-cli light.d.ts.ejs > light.d.ts
  npx tsc --noEmit --strict test.ts
}

unsupported_legacy_build() {
  echo "[B] Legacy Node 6/10/ES5 builds are no longer supported. Use the default Node 22+ build."
  exit 1
}

clean

case "${1:-all}" in
  dev)
    makeLib
    ;;
  light)
    makeLib
    makeLight
    ;;
  typings)
    makeTypings
    ;;
  es5|bench)
    unsupported_legacy_build
    ;;
  all)
    makeLib
    makeLight
    makeTypings
    ;;
  *)
    echo "[B] Unknown build target: $1"
    exit 1
    ;;
esac

echo '[B] Done!'
