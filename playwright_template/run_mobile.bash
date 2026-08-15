#!/usr/bin/env bash
set -e


INCLUDED_PLUGINS=($INCLUDED_PLUGINS)
echo "entry point: $ENTRY_POINT"
echo "entry point type: $ENTRY_POINT_TYPE"
echo "user: $USER"
echo "server path: $SERVER_PATH"
echo "included plugins: $INCLUDED_PLUGINS"
echo "user: $USER"
echo "path to sc command: $SALTCORN_COMMAND"
echo "script dir: $SCRIPT_DIR"

NUM_ITERATIONS=${NUM_ITERATIONS:-1}
DO_BENCHMARK=${DO_BENCHMARK:-false}
echo NUM_ITERATIONS is $NUM_ITERATIONS
echo DO_BENCHMARK is $DO_BENCHMARK

# check if server path ends with a port and extract it
PORT=3010
port_regex=":([0-9]+)$"
if [[ $SERVER_PATH =~ $port_regex ]]; then
  PORT="${BASH_REMATCH[1]}"
  echo "Extracted port: $PORT"
fi

cd $SCRIPT_DIR

BUILD_DIR=/tmp/saltcorn_build

BUILD_ARGS=(
  -p web
  -e "$ENTRY_POINT"
  -t "$ENTRY_POINT_TYPE"
  -b "$BUILD_DIR"
  -u "$USER"
  -s "$SERVER_PATH"
)
# an empty INCLUDED_PLUGINS array expands to nothing, so --includedPlugins
# would be left dangling with no value - only add the flag if there's
# something to pass
if [ "${#INCLUDED_PLUGINS[@]}" -gt 0 ]; then
  BUILD_ARGS+=(--includedPlugins "${INCLUDED_PLUGINS[@]}")
fi

"$SALTCORN_COMMAND" build-app "${BUILD_ARGS[@]}"

# put tables.json into test_schema.js like this: var _test_schema_ = [content from tables.json]
if [ -f $BUILD_DIR/www/data/tables.json ]; then
  echo "var _test_schema_ = $(cat $BUILD_DIR/www/data/tables.json)" > $BUILD_DIR/www/data/test_schema.js
fi

echo Starting background Saltcorn server...
SALTCORN_SERVE_MOBILE_TEST_BUILD=/tmp/saltcorn_build/www saltcorn serve -p $PORT &

SCPID=$!
trap "kill $SCPID" EXIT

while ! nc -z localhost $PORT; do
  sleep 0.2
done

for i in $(seq 1 "$NUM_ITERATIONS"); do
  echo "▶️  Run $i of $NUM_ITERATIONS"
  # don't let 'set -e' stop a benchmark early just because one run failed
  if [ "$DO_BENCHMARK" = true ]; then
    TEST_SERVER="$SERVER_PATH" DO_BENCHMARK=true npx playwright test ./tests/TC_mobile.spec.js || true
  else
    TEST_SERVER="$SERVER_PATH" npx playwright test ./tests/TC_mobile.spec.js
  fi
done
