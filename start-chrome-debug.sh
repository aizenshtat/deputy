#!/bin/bash
# Start Chrome with remote debugging for Deputy agent
# This browser window will stay open and Deputy will connect to it

echo "🌐 Starting Chrome with remote debugging on port 9222..."
echo "📁 Using profile: ~/.chrome-deputy-profile"
echo ""
echo "This Chrome window will stay open even when Deputy is idle."
echo "Your logins and sessions will persist in this profile."
echo ""

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-deputy-profile" \
  --no-first-run \
  --no-default-browser-check &

echo "✅ Chrome started! Deputy can now connect to it."
echo "💡 To stop: Close the Chrome window or run: pkill -f 'remote-debugging-port=9222'"
