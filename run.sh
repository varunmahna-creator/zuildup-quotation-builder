#!/usr/bin/env bash
# ZuildUp Quotation Builder — start internal dev server.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
echo "Starting ZuildUp Quotation Builder from $DIR"
echo "Open http://127.0.0.1:8124/ in a browser"
node app/server.js
