#!/usr/bin/env node
/**
 * Deputy - Autonomous Executive Assistant
 *
 * Main entry point that provides an interactive CLI while
 * the agent runs continuously in the background.
 */

import 'dotenv/config';
import { createInterface } from 'readline';
import { Deputy } from './core/deputy.js';

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

  // Set up readline for interactive input
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Start the agent loop in background
  deputy.start().catch(console.error);

  console.log('\nDeputy is now running. You can:');
  console.log('  • Chat naturally to give instructions');
  console.log('  • Use /status to check progress');
  console.log('  • Use /approvals to see pending items');
  console.log('  • Use /help for all commands\n');

  // Interactive prompt
  const prompt = (): void => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log('\nStopping Deputy...');
        deputy.stop();
        rl.close();
        process.exit(0);
      }

      try {
        const response = await deputy.chat(trimmed);
        console.log(`\nDeputy: ${response}\n`);
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
      }

      prompt();
    });
  };

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nReceived SIGINT. Shutting down gracefully...');
    deputy.stop();
    rl.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n\nReceived SIGTERM. Shutting down gracefully...');
    deputy.stop();
    rl.close();
    process.exit(0);
  });

  prompt();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
