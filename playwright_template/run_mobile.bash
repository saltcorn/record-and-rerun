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

cd $SCRIPT_DIR

BUILD_DIR=/tmp/saltcorn_build

"$SALTCORN_COMMAND" build-app \
  -p web \
  -e "$ENTRY_POINT" \
  -t "$ENTRY_POINT_TYPE" \
  -b "$BUILD_DIR" \
  -u "$USER" \
  -s "$SERVER_PATH" \
  --includedPlugins "${INCLUDED_PLUGINS[@]}"

# put tables.json into test_schema.js like this: var _test_schema_ = [content from tables.json]
if [ -f $BUILD_DIR/www/data/tables.json ]; then
  echo "var _test_schema_ = $(cat $BUILD_DIR/www/data/tables.json)" > $BUILD_DIR/www/data/test_schema.js
fi

echo Starting background Saltcorn server...
SALTCORN_SERVE_MOBILE_TEST_BUILD=/tmp/saltcorn_build/www saltcorn serve -p 3010 &

SCPID=$!
trap "kill $SCPID" EXIT

while ! nc -z localhost 3010; do
  sleep 0.2
done

npx playwright test ./tests/TC_mobile.spec.js
