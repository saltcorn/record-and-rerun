#!/usr/bin/env bash
set -e


INCLUDED_PLUGINS=($INCLUDED_PLUGINS)
echo "### Environment Variables ###"
echo $ENTRY_POINT
echo $ENTRY_POINT_TYPE
echo $USER
echo $SERVER_PATH
echo $INCLUDED_PLUGINS
echo $USER
echo $SCRIPT_DIR


cd $SCRIPT_DIR

BUILD_DIR=/tmp/saltcorn_build

PATH=../../packages/saltcorn-cli/bin/:$PATH
saltcorn build-app \
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
