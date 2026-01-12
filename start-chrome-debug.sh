#!/bin/bash
# Start Chrome with remote debugging for Deputy + Playwright MCP
# Playwright MCP connects via CDP to this Chrome instance, preserving your login sessions

echo "🌐 Starting Chrome with remote debugging on port 9222..."
echo "📁 Using profile: ~/.chrome-deputy-profile"
echo ""
echo "This Chrome keeps your login sessions (Gmail, Slack, etc.)"
echo "Deputy connects via Playwright MCP using --cdp-endpoint"
echo ""

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-deputy-profile" \
  --no-first-run \
  --no-default-browser-check &

sleep 2

# Verify Chrome is accessible
if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
  echo "✅ Chrome started and CDP endpoint ready!"
  echo "💡 Deputy will connect via: http://127.0.0.1:9222"
else
  echo "⚠️  Chrome started but CDP endpoint not responding yet"
  echo "   Wait a moment and verify with: curl http://127.0.0.1:9222/json/version"
fi

echo ""
echo "💡 To stop: Close Chrome window or run: pkill -f 'remote-debugging-port=9222'"
