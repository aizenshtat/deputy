# Deputy - Autonomous Executive Assistant Agent

Deputy is an autonomous executive assistant agent built with the [Claude Agent SDK](https://github.com/anthropics/anthropic-agent-sdk). It runs continuously in the background, managing tasks, goals, and responsibilities while learning from experience.

## Key Features

### 🧠 Autonomous Memory System
Deputy can **modify its own memory** during execution through 5 custom MCP tools:
- **StoreKnowledge** - Stores learnings, preferences, and insights automatically
- **CreateGoal** - Creates goals from natural conversation
- **CreateResponsibility** - Sets up recurring responsibilities with cadences
- **CreateTask** - Proactively generates tasks while working
- **UpdateTaskContext** - Enriches tasks with discoveries and findings

### 🌐 Browser Automation
Full Chrome DevTools MCP integration with **26 browser automation tools**:
- Page navigation and tab management
- Form filling and element interaction
- Screenshot capture and DOM inspection
- Performance analysis and network monitoring
- JavaScript evaluation in page context

Supports **persistent browser sessions** - your logins and cookies persist across runs.

### 📋 Task Management
- **Priority-based task queue** - Critical, high, medium, low priorities
- **Goal decomposition** - Break down objectives into actionable tasks
- **Responsibility tracking** - Ongoing commitments with recurring cadences
- **Approval system** - High-risk operations require human approval
- **Continuous operation** - Background loop processes tasks autonomously

### 💾 Persistent State
Everything is saved to disk and restored on restart:
- Task queue and completion history
- Goals and progress tracking
- Responsibilities and activity logs
- Context store with accumulated knowledge
- Conversation session (continues where you left off)

## Architecture

Deputy uses a **3-tier architecture**:

```
┌─────────────────────────────────────┐
│   Background Loop (5s polling)      │
│   - Process pending tasks           │
│   - Handle approvals                │
│   - Run autonomous scanner (30m)    │
└─────────────────────────────────────┘
              ↓
┌─────────────────────────────────────┐
│   Agent Tier (Claude SDK)           │
│   - Task execution with tools       │
│   - Chat interface                  │
│   - Supervision hooks               │
└─────────────────────────────────────┘
              ↓
┌─────────────────────────────────────┐
│   Memory Tier (Persistent)          │
│   - TaskQueue                       │
│   - GoalManager                     │
│   - ResponsibilityManager           │
│   - ContextStore                    │
│   - ApprovalQueue                   │
└─────────────────────────────────────┘
```

### How It Works

1. **Background Loop** runs every 5 seconds:
   - Picks highest priority pending task
   - Executes using Claude Agent SDK
   - If blocked on approval, moves to next task
   - Never blocks - keeps working

2. **Autonomous Scanner** runs every 30 minutes:
   - Checks for due cadences (daily/weekly/monthly)
   - Finds responsibilities needing attention
   - Identifies goals without tasks
   - Generates tasks automatically

3. **Memory System** persists everything:
   - Auto-saves on every change (debounced 1s)
   - Restores full state on startup
   - Session continuity across restarts

## Installation

### Prerequisites
- **Node.js 22+** (for Agent SDK and Chrome DevTools MCP)
- **Chrome browser** (for browser automation)
- **GitHub CLI** (optional, for gh commands)

### Setup

```bash
# Clone the repository
git clone https://github.com/aizenshtat/deputy.git
cd deputy

# Install dependencies
npm install

# Build
npm run build

# Start Deputy
npm start
```

## Configuration

### Environment Variables
Create a `.env` file (optional):
```bash
# Model selection
MODEL=claude-sonnet-4-5-20250929  # or claude-opus-4-5-20251101

# Working directory
WORKING_DIRECTORY=.

# Polling interval (ms)
POLLING_INTERVAL=5000
```

### MCP Servers
Configure in `.mcp.json`:
```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--browser-url=http://127.0.0.1:9222"
      ]
    }
  }
}
```

## Chrome Persistent Session Setup

By default, Chrome DevTools MCP closes the browser after tasks complete. For persistent sessions (logins, cookies, etc.), use a manual Chrome instance.

### Start Persistent Chrome

```bash
./start-chrome-debug.sh
```

This opens a Chrome window on port 9222 that Deputy connects to. The browser stays open until you manually close it.

**Benefits:**
- ✅ Browser stays open indefinitely
- ✅ Manual logins work without timeout
- ✅ Sessions persist across Deputy restarts
- ✅ Profile saved to `~/.chrome-deputy-profile`

### Stop Persistent Chrome

```bash
# Close the Chrome window, or:
pkill -f 'remote-debugging-port=9222'
```

## Usage

### Starting Deputy

```bash
npm start
```

Deputy starts in interactive mode with:
- Background loop processing tasks
- Chat interface for commands and conversation

### Chat Commands

**Goal Management:**
```bash
/goal Launch new dashboard - Build and deploy the new admin dashboard
/goals                    # List all goals
```

**Task Management:**
```bash
/task Fix login bug - Users can't log in with SSO
/tasks                    # List all tasks
/status                   # Overall status report
```

**Responsibility Management:**
```bash
/responsibility add Daily standup prep
/responsibilities         # List all responsibilities
```

**Approval System:**
```bash
/approvals                # List pending approvals
/approve <id>             # Approve an action
/reject <id> <reason>     # Reject with reason
```

**Context Management:**
```bash
/context                  # Show accumulated knowledge
/context person John      # Filter by category
```

### Natural Language Interaction

Deputy understands natural language:

```
You: We need to hire 3 senior engineers by March

Deputy: 🎯 Created goal: Hire 3 senior engineers (abc12345)
        ✅ Created task: Write job description (def67890)
        ✅ Created task: Post to job boards (ghi11121)

        I've created a goal with 2 initial tasks. Would you like me to start?
```

```
You: I need daily standup prep at 9am

Deputy: 📋 Created responsibility: Daily standup prep (mno16171)
        Added daily cadence: Prepare standup notes

        I'll prepare standup materials daily and create tasks as needed.
```

### Autonomous Task Execution

Deputy works through tasks automatically:

1. **Task appears in queue** (from goal, responsibility, or manual creation)
2. **Deputy picks it up** and starts execution
3. **High-risk actions trigger approval** (file writes, bash commands, etc.)
4. **Task pauses if blocked**, Deputy moves to next task
5. **You approve/reject**, Deputy continues
6. **Task completes**, progress tracked

### Learning System

Deputy automatically stores knowledge during execution:

```
Agent discovers: "Screenshots need 3 seconds to load"
📝 Stored: screenshot-validation-delay

Agent learns: "User prefers executive summaries"
📝 Stored: user-summary-preference

Agent notes: "Project X uses React 18"
📝 Stored: project-x-stack
```

View accumulated knowledge:
```bash
/context
```

## Advanced Usage

### Autonomous Scanner

The scanner runs every 30 minutes when idle:
- Checks due cadences (daily standup, weekly report, etc.)
- Finds stale responsibilities (>24hrs inactive)
- Identifies goals without tasks
- Generates tasks automatically

### Approval System

High-risk operations require approval:
- Bash commands (except safe ones like `ls`, `npm test`)
- File writes outside project directory
- External communications
- Destructive operations

Configure approval threshold in `src/core/deputy.ts`:
```typescript
autoApproveThreshold: 'none' | 'low' | 'medium' | 'high'
```

### Custom Tools

Deputy has access to:
- **Built-in SDK tools**: Read, Write, Edit, Bash, Glob, Grep
- **Web tools**: WebFetch, WebSearch
- **Chrome DevTools**: All 26 browser automation tools
- **Custom Deputy tools**: 5 autonomous memory tools
- **Task delegation**: Spawn specialized subagents

## Development

### Project Structure

```
deputy/
├── src/
│   ├── core/              # Core agent logic
│   │   ├── deputy.ts      # Main orchestrator
│   │   ├── task-queue.ts  # Task management
│   │   └── approval-queue.ts
│   ├── memory/            # Persistence layer
│   │   ├── goals.ts
│   │   ├── responsibilities.ts
│   │   ├── context-store.ts
│   │   └── persistence.ts
│   ├── hooks/             # Tool use hooks
│   │   ├── supervision.ts # Approval interception
│   │   └── audit-log.ts   # Tool use logging
│   ├── config/            # Configuration
│   │   └── system-prompt.ts
│   └── index.ts           # Entry point
├── data/                  # Persisted state (gitignored)
├── .mcp.json             # MCP server config
└── start-chrome-debug.sh  # Chrome helper script
```

### Building

```bash
npm run build     # Compile TypeScript
npm run dev       # Watch mode
```

### Adding Custom Tools

Create a new tool in `deputy.ts`:

```typescript
tool(
  "MyCustomTool",
  "Description of what it does",
  {
    param1: z.string().describe("First parameter"),
    param2: z.number().optional()
  },
  async (args) => {
    // Implementation
    return { content: [{ type: "text" as const, text: "Result" }] };
  }
)
```

Add to the `deputy-tools` MCP server in `createDeputyTools()` method.

### System Prompt Customization

Edit `src/config/system-prompt.ts` to customize:
- Deputy's persona and behavior
- Available capabilities description
- Communication style
- Task management guidelines

## Troubleshooting

### "Connection refused" when starting Deputy
- Make sure you started the debug Chrome first: `./start-chrome-debug.sh`
- Check if Chrome is running: `lsof -i :9222`

### Browser closes immediately
- Use persistent Chrome: `./start-chrome-debug.sh`
- Verify `.mcp.json` has `--browser-url=http://127.0.0.1:9222`

### Session not continuing after restart
- Check if `data/deputy-state.json` exists
- Verify state is being saved (look for "Restored state from disk" message)

### Tasks stuck in "waiting_approval"
- Check pending approvals: `/approvals`
- Approve or reject them: `/approve <id>` or `/reject <id> reason`

### Memory not persisting
- Ensure `data/` directory exists and is writable
- Check for file system errors in logs

## Contributing

Contributions welcome! Areas for improvement:
- Additional specialized subagents
- Enhanced approval learning (pattern recognition)
- Goal progress auto-tracking
- Confidence decay for old knowledge
- Web interface for task/goal management

## License

MIT

## Credits

Built with:
- [Claude Agent SDK](https://github.com/anthropics/anthropic-agent-sdk)
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Anthropic Claude API](https://www.anthropic.com/claude)

## Links

- **Repository**: https://github.com/aizenshtat/deputy
- **Chrome DevTools MCP**: https://developer.chrome.com/blog/chrome-devtools-mcp
- **Agent SDK Docs**: https://platform.claude.com/docs/en/agent-sdk
