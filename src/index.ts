#!/usr/bin/env node
/**
 * Deputy - Autonomous Executive Assistant
 *
 * Main entry point that provides an interactive CLI while
 * the agent runs continuously in the background.
 */

import 'dotenv/config';
import * as readline from 'readline';
import { Deputy } from './core/deputy.js';
import { colors } from './utils/colors.js';

const BANNER = `
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   ██████╗ ███████╗██████╗ ██╗   ██╗████████╗██╗   ██╗    ║
║   ██╔══██╗██╔════╝██╔══██╗██║   ██║╚══██╔══╝╚██╗ ██╔╝    ║
║   ██║  ██║█████╗  ██████╔╝██║   ██║   ██║    ╚████╔╝     ║
║   ██║  ██║██╔══╝  ██╔═══╝ ██║   ██║   ██║     ╚██╔╝      ║
║   ██████╔╝███████╗██║     ╚██████╔╝   ██║      ██║       ║
║   ╚═════╝ ╚══════╝╚═╝      ╚═════╝    ╚═╝      ╚═╝       ║
║                                                           ║
║   Autonomous Executive Assistant                          ║
║   Type /help for commands, or just chat naturally         ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`;

async function main(): Promise<void> {
  console.log(BANNER);

  // Authentication is handled automatically by the SDK
  // Option A: Set CLAUDE_OAUTH_TOKEN (get with: claude config get oauthToken)
  // Option B: Set ANTHROPIC_API_KEY for API access

  // Initialize Deputy
  const deputy = new Deputy({
    workingDirectory: process.cwd(),
    dataDirectory: process.env.DEPUTY_DATA_DIR ?? './data',
    model: process.env.DEPUTY_MODEL,
  });

  await deputy.init();

  // Start the agent loop in background
  deputy.start().catch(console.error);

  console.log(colors.success('\nDeputy is now running. You can:'));
  console.log(`  ${colors.dim('•')} Chat naturally to give instructions`);
  console.log(`  ${colors.dim('•')} Use ${colors.info('/status')} to check progress`);
  console.log(`  ${colors.dim('•')} Use ${colors.info('/approvals')} to see pending items`);
  console.log(`  ${colors.dim('•')} Use ${colors.info('/help')} for all commands`);
  console.log(`  ${colors.dim('•')} Press ${colors.info('Tab')} for command completion\n`);

  // Tab completion function
  const completer = (line: string): [string[], string] => {
    const commands = [
      '/status',
      '/tasks',
      '/approvals',
      '/approve',
      '/reject',
      '/goals',
      '/context',
      '/responsibilities',
      '/scan',
      '/help',
    ];

    // Smart completion for /context
    if (line.startsWith('/context ')) {
      const afterCommand = line.slice(9); // Remove '/context '
      const parts = afterCommand.split(' ');

      // If typing a subcommand that needs an ID, show available entries
      if (parts.length >= 2 && (parts[0] === 'show' || parts[0] === 'delete')) {
        const entries = deputy.getContextStore().getAllEntries();
        const searchTerm = parts.slice(1).join(' ').toLowerCase();

        const matches = entries
          .filter((e) =>
            !searchTerm ||
            e.key.toLowerCase().includes(searchTerm) ||
            e.id.toLowerCase().startsWith(searchTerm)
          )
          .map((e) => `/context ${parts[0]} ${e.key}`);

        return [matches, line];
      }

      // Otherwise show subcommand options
      const subcommands = ['list', 'add', 'delete', 'show'];
      const typed = parts[0];
      const matches = subcommands.filter((s) => s.startsWith(typed));
      return [matches.map((s) => `/context ${s}`), line];
    }

    // Smart completion for /tasks
    if (line.startsWith('/tasks ')) {
      const afterCommand = line.slice(7); // Remove '/tasks '
      const parts = afterCommand.split(' ');

      // If typing a subcommand that needs an ID, show available tasks
      if (parts.length >= 2 && (parts[0] === 'show' || parts[0] === 'delete')) {
        const tasks = deputy.getTaskQueue().getAllTasks();
        const searchTerm = parts.slice(1).join(' ').toLowerCase();

        const matches = tasks
          .filter((t) =>
            !searchTerm ||
            t.title.toLowerCase().includes(searchTerm) ||
            t.id.toLowerCase().startsWith(searchTerm)
          )
          .map((t) => `/tasks ${parts[0]} ${t.id.slice(0, 8)}`);

        return [matches, line];
      }

      // Otherwise show subcommand options
      const subcommands = ['list', 'add', 'show', 'delete'];
      const typed = parts[0];
      const matches = subcommands.filter((s) => s.startsWith(typed));
      return [matches.map((s) => `/tasks ${s}`), line];
    }

    // Smart completion for /goals
    if (line.startsWith('/goals ')) {
      const afterCommand = line.slice(7); // Remove '/goals '
      const parts = afterCommand.split(' ');

      // If typing a subcommand that needs an ID, show available goals
      if (parts.length >= 2 && (parts[0] === 'show' || parts[0] === 'delete')) {
        const goals = deputy.getGoalManager().getAllGoals();
        const searchTerm = parts.slice(1).join(' ').toLowerCase();

        const matches = goals
          .filter((g) =>
            !searchTerm ||
            g.title.toLowerCase().includes(searchTerm) ||
            g.id.toLowerCase().startsWith(searchTerm)
          )
          .map((g) => `/goals ${parts[0]} ${g.id.slice(0, 8)}`);

        return [matches, line];
      }

      // Otherwise show subcommand options
      const subcommands = ['list', 'add', 'show', 'delete'];
      const typed = parts[0];
      const matches = subcommands.filter((s) => s.startsWith(typed));
      return [matches.map((s) => `/goals ${s}`), line];
    }

    // Smart completion for /responsibilities
    if (line.startsWith('/responsibilities ')) {
      const afterCommand = line.slice(18); // Remove '/responsibilities '
      const parts = afterCommand.split(' ');

      // If typing a subcommand that needs an ID, show available responsibilities
      if (parts.length >= 2 && (parts[0] === 'show' || parts[0] === 'delete' || parts[0] === 'pause' || parts[0] === 'resume' || parts[0] === 'phase')) {
        const responsibilities = deputy.getResponsibilityManager().getAll();
        const searchTerm = parts.slice(1).join(' ').toLowerCase();

        const matches = responsibilities
          .filter((r) =>
            !searchTerm ||
            r.name.toLowerCase().includes(searchTerm) ||
            r.id.toLowerCase().startsWith(searchTerm)
          )
          .map((r) => `/responsibilities ${parts[0]} ${r.id.slice(0, 8)}`);

        return [matches, line];
      }

      // Otherwise show subcommand options
      const subcommands = ['list', 'add', 'show', 'delete', 'phase', 'pause', 'resume'];
      const typed = parts[0];
      const matches = subcommands.filter((s) => s.startsWith(typed));
      return [matches.map((s) => `/responsibilities ${s}`), line];
    }

    // Special handling for /approve and /reject - complete with approval IDs
    if (line.startsWith('/approve ') || line.startsWith('/reject ')) {
      const approvals = deputy.getApprovalQueue().getPending();
      const prefix = line.startsWith('/approve ') ? '/approve ' : '/reject ';
      const searchTerm = line.slice(prefix.length).toLowerCase();

      const completions = approvals
        .filter(
          (a) =>
            !searchTerm ||
            a.id.toLowerCase().startsWith(searchTerm) ||
            a.title.toLowerCase().includes(searchTerm)
        )
        .map((a) => `${prefix}${a.id.slice(0, 8)}`);

      return [completions, line];
    }

    // Normal command completion
    const hits = commands.filter((c) => c.startsWith(line));
    return [hits.length ? hits : commands, line];
  };

  // Create readline interface with tab completion and history
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer,
    prompt: `${colors.success('❯')} ${colors.bold('You:')} `,
  });

  // Track the last injected task ID to avoid duplicates
  let lastInjectedTaskId: string | undefined;

  // Function to update history with current task
  const updateCurrentTaskInHistory = () => {
    const currentTaskId = deputy.getCurrentTaskId();

    // Remove old injected command if task changed or completed
    if (lastInjectedTaskId && lastInjectedTaskId !== currentTaskId) {
      const oldCommand = `/tasks show ${lastInjectedTaskId.slice(0, 8)}`;
      const historyArray = (rl as any).history;
      const index = historyArray.indexOf(oldCommand);
      if (index !== -1) {
        historyArray.splice(index, 1);
      }
    }

    // Inject new current task command at front of history
    if (currentTaskId && currentTaskId !== lastInjectedTaskId) {
      const taskShowCommand = `/tasks show ${currentTaskId.slice(0, 8)}`;
      const historyArray = (rl as any).history;

      // Remove if it exists elsewhere in history
      const existingIndex = historyArray.indexOf(taskShowCommand);
      if (existingIndex !== -1) {
        historyArray.splice(existingIndex, 1);
      }

      // Add to front
      historyArray.unshift(taskShowCommand);
      lastInjectedTaskId = currentTaskId;
    } else if (!currentTaskId && lastInjectedTaskId) {
      // Task completed, remove the injected command
      const oldCommand = `/tasks show ${lastInjectedTaskId.slice(0, 8)}`;
      const historyArray = (rl as any).history;
      const index = historyArray.indexOf(oldCommand);
      if (index !== -1) {
        historyArray.splice(index, 1);
      }
      lastInjectedTaskId = undefined;
    }
  };

  // Update history periodically to track current task
  setInterval(updateCurrentTaskInHistory, 1000);

  // Show initial prompt
  rl.prompt();

  // Handle user input
  rl.on('line', async (input: string) => {
    const trimmed = input.trim();

    if (!trimmed) {
      rl.prompt();
      return;
    }

    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
      console.log('\nStopping Deputy...');
      rl.close();
      deputy.stop();
      process.exit(0);
    }

    try {
      const response = await deputy.chat(trimmed);
      console.log(`\n${response}\n`);
    } catch (error: any) {
      console.error(colors.error('Error:'), error instanceof Error ? error.message : error);
    }

    rl.prompt();
  });

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\nReceived SIGINT. Shutting down gracefully...');
    rl.close();
    await deputy.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\nReceived SIGTERM. Shutting down gracefully...');
    rl.close();
    await deputy.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
