/**
 * MCP Configuration Example for Deputy Agent
 *
 * This file shows how to configure Chrome DevTools MCP
 * and whitelist all its tools using the wildcard syntax.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

// Chrome DevTools MCP Configuration
export const chromeDevToolsMCP = {
  "chrome-devtools": {
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest"]
  }
};

// OPTION 1: Wildcard syntax (added in Claude Code 2.0.70)
// This allows ALL tools from the chrome-devtools MCP server
export const allChromeDevToolsWildcard = [
  "mcp__chrome-devtools__*"
];

// OPTION 2: Explicitly list all 26 tools (fallback if wildcard doesn't work)
export const allChromeDevToolsExplicit = [
  // Input Automation (8 tools)
  "mcp__chrome-devtools__click",
  "mcp__chrome-devtools__drag",
  "mcp__chrome-devtools__fill",
  "mcp__chrome-devtools__fill_form",
  "mcp__chrome-devtools__handle_dialog",
  "mcp__chrome-devtools__hover",
  "mcp__chrome-devtools__press_key",
  "mcp__chrome-devtools__upload_file",

  // Navigation Automation (6 tools)
  "mcp__chrome-devtools__close_page",
  "mcp__chrome-devtools__list_pages",
  "mcp__chrome-devtools__navigate_page",
  "mcp__chrome-devtools__new_page",
  "mcp__chrome-devtools__select_page",
  "mcp__chrome-devtools__wait_for",

  // Emulation (2 tools)
  "mcp__chrome-devtools__emulate",
  "mcp__chrome-devtools__resize_page",

  // Performance (3 tools)
  "mcp__chrome-devtools__performance_analyze_insight",
  "mcp__chrome-devtools__performance_start_trace",
  "mcp__chrome-devtools__performance_stop_trace",

  // Network (2 tools)
  "mcp__chrome-devtools__get_network_request",
  "mcp__chrome-devtools__list_network_requests",

  // Debugging (5 tools)
  "mcp__chrome-devtools__evaluate_script",
  "mcp__chrome-devtools__get_console_message",
  "mcp__chrome-devtools__list_console_messages",
  "mcp__chrome-devtools__take_screenshot",
  "mcp__chrome-devtools__take_snapshot",
];

// Example usage in a query
async function exampleWithChromeDevTools() {
  for await (const message of query({
    prompt: "Navigate to https://example.com and take a screenshot",
    options: {
      mcpServers: chromeDevToolsMCP,
      // Use wildcard (recommended)
      allowedTools: [
        "Read", "Write", "Edit", "Bash",
        ...allChromeDevToolsWildcard
      ],
      // OR use explicit list (fallback)
      // allowedTools: [
      //   "Read", "Write", "Edit", "Bash",
      //   ...allChromeDevToolsExplicit
      // ],
    }
  })) {
    if (message.type === "result" && message.subtype === "success") {
      console.log(message.result);
    }
  }
}

export { exampleWithChromeDevTools };
