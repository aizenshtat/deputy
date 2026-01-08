import chalk from 'chalk';

/**
 * Simple markdown renderer for terminal
 * Handles basic markdown syntax with colors
 */
export function renderMarkdown(markdown: string): string {
  let output = markdown;

  // H1 headers (# text)
  output = output.replace(/^# (.+)$/gm, (_, text) => chalk.cyan.bold.underline(text) + '\n');

  // H2 headers (## text)
  output = output.replace(/^## (.+)$/gm, (_, text) => '\n' + chalk.cyan.bold(text));

  // H3 headers (### text)
  output = output.replace(/^### (.+)$/gm, (_, text) => chalk.cyan(text));

  // Bold (**text** or __text__)
  output = output.replace(/\*\*(.+?)\*\*/g, (_, text) => chalk.bold(text));
  output = output.replace(/__(.+?)__/g, (_, text) => chalk.bold(text));

  // Italic (*text* only - removed underscore variant to avoid conflicts with identifiers)
  output = output.replace(/\*([^*]+?)\*/g, (_, text) => chalk.italic(text));

  // Inline code (`code`) - process BEFORE list items to prevent conflicts
  output = output.replace(/`([^`]+?)`/g, (_, text) => chalk.yellow(text));

  // Nested lists (  - item or   * item) - handle indentation
  output = output.replace(/^(\s{2,})[*-] (.+)$/gm, (_, spaces, text) => {
    const indent = spaces.length / 2;
    return '  '.repeat(indent) + chalk.green('○') + ' ' + text;
  });

  // Top-level lists (- item or * item)
  output = output.replace(/^[*-] (.+)$/gm, (_, text) => chalk.green('●') + ' ' + text);

  // Links [text](url)
  output = output.replace(/\[(.+?)\]\((.+?)\)/g, (_, text, url) => chalk.blue.underline(text));

  // Horizontal rules (---)
  output = output.replace(/^---+$/gm, chalk.dim('─'.repeat(50)));

  return output;
}

/**
 * Centralized color definitions for consistent CLI output
 */
export const colors = {
  // Status colors
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.cyan,

  // Risk levels
  highRisk: chalk.red.bold,
  mediumRisk: chalk.yellow.bold,
  lowRisk: chalk.green,

  // Task statuses
  pending: chalk.gray,
  in_progress: chalk.blue,
  inProgress: chalk.blue,
  completed: chalk.green,
  failed: chalk.red,
  waiting_approval: chalk.yellow,
  waitingApproval: chalk.yellow,
  approved: chalk.green.dim,
  cancelled: chalk.gray.dim,

  // UI elements
  header: chalk.bold.cyan,
  subheader: chalk.bold.white,
  dim: chalk.dim,
  bold: chalk.bold,
  id: chalk.gray.dim,
};

/**
 * Status symbols for visual indicators
 */
export const statusSymbols = {
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
  pending: '○',
  inProgress: '◉',
  completed: '●',
  failed: '✗',
};
