#!/usr/bin/env bash

set -e

source .env

echo 'Build'
./scripts/build.sh

echo 'ioredis tests'
DATASTORE=ioredis npm test

echo 'NodeRedis tests'
DATASTORE=redis npm test

echo 'Light bundle tests'
BUILD=light npm test

echo 'Local tests'
npm test
