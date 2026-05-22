#!/bin/bash
# Replaces {{BUILD_TIME}} in sw.js with current timestamp at build time
TIMESTAMP=$(date +%s)
sed -i "s/{{BUILD_TIME}}/$TIMESTAMP/g" sw.js
echo "Service worker cache version: mxlogbook-$TIMESTAMP"
