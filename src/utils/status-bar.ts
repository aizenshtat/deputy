/**
 * Status Bar - Bottom terminal status line that updates without interfering with output
 */

import * as readline from 'readline';
import { colors } from './colors.js';

export class StatusBar {
  private enabled: boolean = true;
  private currentStatus: string = '';
  private lastUpdate: number = 0;
  private throttleMs: number = 100; // Update max every 100ms to prevent flicker

  constructor() {
    // Detect if we're in a TTY
    this.enabled = process.stdout.isTTY;
  }

  /**
   * Update the status bar without moving scroll position or interfering with input
   */
  update(status: string): void {
    if (!this.enabled) return;

    // Throttle updates to prevent flicker
    const now = Date.now();
    if (now - this.lastUpdate < this.throttleMs) {
      return;
    }
    this.lastUpdate = now;

    this.currentStatus = status;

    // Save cursor position
    process.stdout.write('\x1b7');

    // Get terminal size
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;

    // Move to bottom row
    process.stdout.write(`\x1b[${rows};0H`);

    // Clear the line
    process.stdout.write('\x1b[K');

    // Truncate status to fit terminal width
    const truncated = status.length > cols ? status.slice(0, cols - 3) + '...' : status;

    // Write status with background color
    process.stdout.write(colors.dim(truncated));

    // Restore cursor position
    process.stdout.write('\x1b8');
  }

  /**
   * Clear the status bar
   */
  clear(): void {
    if (!this.enabled) return;

    this.currentStatus = '';

    // Save cursor position
    process.stdout.write('\x1b7');

    // Get terminal size
    const rows = process.stdout.rows || 24;

    // Move to bottom row
    process.stdout.write(`\x1b[${rows};0H`);

    // Clear the line
    process.stdout.write('\x1b[K');

    // Restore cursor position
    process.stdout.write('\x1b8');
  }

  /**
   * Disable status bar updates (e.g., when not in TTY)
   */
  disable(): void {
    this.enabled = false;
  }

  /**
   * Enable status bar updates
   */
  enable(): void {
    this.enabled = true;
  }
}

/**
 * Format task status for the status bar
 */
export function formatTaskStatus(params: {
  taskTitle: string;
  elapsedSeconds: number;
  latestAction?: string;
}): string {
  const { taskTitle, elapsedSeconds, latestAction } = params;

  const mins = Math.floor(elapsedSeconds / 60);
  const secs = elapsedSeconds % 60;
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  // Truncate task title
  const title = taskTitle.length > 35 ? taskTitle.slice(0, 35) + '...' : taskTitle;

  let status = `⚙️  ${title} | ${timeStr}`;

  if (latestAction) {
    // Truncate latest action
    const action = latestAction.length > 40 ? latestAction.slice(0, 40) + '...' : latestAction;
    status += ` | ${action}`;
  }

  return status;
}
