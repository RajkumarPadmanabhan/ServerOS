#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "ServerOS needs Node.js 16 or newer."
  echo "Download it from https://nodejs.org and run this again."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Setting up ServerOS. This needs an internet connection the first time."
  npm install || exit 1
fi
exec node src/index.js
