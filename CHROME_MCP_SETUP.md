# Chrome DevTools MCP Setup for Deputy Agent

## What Was Configured

Your Deputy agent now has access to **all 26 Chrome DevTools MCP tools** for browser automation and debugging.

## Configuration Files

### 1. `.mcp.json` (Root Configuration)
```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

### 2. `deputy.ts` (Agent Code)
The Chrome DevTools MCP is integrated in two places:
- **Task execution** (line 256-260): For executing autonomous tasks
- **Chat handling** (line 345-349): For responding to user chat messages

### 3. Wildcard Syntax Used
```typescript
allowedTools: [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task',
  'mcp__chrome-devtools__*', // ⭐ Allows ALL chrome-devtools tools
]
```

The wildcard syntax `mcp__chrome-devtools__*` was introduced in **Claude Code CLI 2.0.70** to allow all tools from a specific MCP server without listing each one individually.

## Available Tools (26 Total)

### 📝 Input Automation (8 tools)
- `click` - Activate elements on the page
- `drag` - Move elements via drag operations
- `fill` - Input text into form fields
- `fill_form` - Populate multiple form fields simultaneously
- `handle_dialog` - Respond to browser dialogs
- `hover` - Trigger hover states on elements
- `press_key` - Execute keyboard commands
- `upload_file` - Submit files through file inputs

### 🧭 Navigation Automation (6 tools)
- `close_page` - Shut down a browser tab
- `list_pages` - Retrieve all open tabs
- `navigate_page` - Load a URL in the current tab
- `new_page` - Open an additional browser tab
- `select_page` - Switch focus between tabs
- `wait_for` - Pause execution until conditions are met

### 🎭 Emulation (2 tools)
- `emulate` - Simulate different devices or network conditions
- `resize_page` - Adjust the viewport dimensions

### ⚡ Performance (3 tools)
- `performance_analyze_insight` - Extract actionable metrics from traces
- `performance_start_trace` - Begin recording performance data
- `performance_stop_trace` - End recording and retrieve results

### 🌐 Network (2 tools)
- `get_network_request` - Retrieve details about a specific request
- `list_network_requests` - View all captured network activity

### 🔍 Debugging (5 tools)
- `evaluate_script` - Execute JavaScript in the page context
- `get_console_message` - Fetch a specific console entry
- `list_console_messages` - Retrieve all logged console output
- `take_screenshot` - Capture the current viewport
- `take_snapshot` - Record the DOM structure

## How to Use

### Example 1: Take a Screenshot
```typescript
// Just ask Deputy in chat:
"Take a screenshot of https://example.com"
```

### Example 2: Performance Analysis
```typescript
// Just ask Deputy:
"Analyze the performance of https://myapp.com"
```

### Example 3: Automate Form Filling
```typescript
// Just ask Deputy:
"Go to the login page and fill in the test credentials"
```

## Testing the Integration

1. Build your project:
   ```bash
   npm run build
   ```

2. Start Deputy:
   ```bash
   npm start
   ```

3. Test with a simple browser task:
   ```
   You: Take a screenshot of https://example.com
   ```

## Fallback: Explicit Tool List

If the wildcard syntax doesn't work in the Agent SDK (it was designed for Claude Code), you can use the explicit list of all 26 tools found in `mcp-config-example.ts`.

Replace:
```typescript
'mcp__chrome-devtools__*'
```

With:
```typescript
...allChromeDevToolsExplicit  // Import from mcp-config-example.ts
```

## Troubleshooting

### Issue: "MCP server failed to connect"
- Ensure Node.js 22+ is installed
- Ensure Chrome browser is installed
- Check network connectivity for npx download

### Issue: "Tool not found"
- Check if wildcard syntax is supported in your SDK version
- Fall back to explicit tool list in `mcp-config-example.ts`

### Issue: "Permission denied"
- Chrome DevTools MCP needs to launch Chrome
- Check system permissions for browser automation

## References

- [Chrome DevTools MCP GitHub](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Chrome DevTools MCP Documentation](https://developer.chrome.com/blog/chrome-devtools-mcp)
- [Claude Agent SDK MCP Guide](https://platform.claude.com/docs/en/agent-sdk/mcp)
- [Wildcard Feature (Claude Code 2.0.70)](https://x.com/CCpromptChanges/status/2000724534337356067)

## What Changed

✅ Added `.mcp.json` configuration
✅ Integrated Chrome DevTools MCP in `deputy.ts`
✅ Whitelisted all 26 tools using wildcard syntax
✅ Created example configuration file
✅ Created this documentation
