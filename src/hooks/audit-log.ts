/**
 * Audit Log Hook - Records all agent actions for supervision
 */

import { appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

export interface AuditEntry {
  timestamp: string;
  event: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  sessionId: string;
  taskId?: string;
}

export class AuditLog {
  private logDir: string;
  private logFile: string;

  constructor(dataDir: string) {
    this.logDir = join(dataDir, 'logs');
    this.logFile = join(this.logDir, `audit-${new Date().toISOString().split('T')[0]}.jsonl`);
  }

  async init(): Promise<void> {
    if (!existsSync(this.logDir)) {
      await mkdir(this.logDir, { recursive: true });
    }
  }

  async log(entry: Omit<AuditEntry, 'timestamp'>): Promise<void> {
    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    await appendFile(this.logFile, JSON.stringify(fullEntry) + '\n', 'utf-8');
  }

  /**
   * Create PreToolUse hook callback
   */
  createPreToolUseHook(taskId?: string): HookCallback {
    return async (input) => {
      if ('tool_name' in input) {
        const toolInput = 'tool_input' in input ? input.tool_input : undefined;

        // Real-time console output
        console.log(`  [TOOL] ${input.tool_name}`);
        if (toolInput && typeof toolInput === 'object') {
          const summary = this.summarizeInput(toolInput);
          if (summary) console.log(`         ${summary}`);
        }

        await this.log({
          event: 'PreToolUse',
          toolName: input.tool_name,
          input: toolInput,
          sessionId: input.session_id,
          taskId,
        });
      }
      return {};
    };
  }

  /**
   * Summarize tool input for console display
   */
  private summarizeInput(input: unknown): string {
    if (!input || typeof input !== 'object') return '';
    const obj = input as Record<string, unknown>;

    // Common patterns
    if ('url' in obj) return `→ ${obj.url}`;
    if ('file_path' in obj) return `→ ${obj.file_path}`;
    if ('command' in obj) return `$ ${String(obj.command).slice(0, 60)}...`;
    if ('query' in obj) return `? ${obj.query}`;
    if ('pattern' in obj) return `/ ${obj.pattern}`;
    if ('prompt' in obj) return `> ${String(obj.prompt).slice(0, 50)}...`;

    return '';
  }

  /**
   * Create PostToolUse hook callback
   */
  createPostToolUseHook(taskId?: string): HookCallback {
    return async (input) => {
      if ('tool_name' in input && 'tool_response' in input) {
        await this.log({
          event: 'PostToolUse',
          toolName: input.tool_name,
          input: 'tool_input' in input ? input.tool_input : undefined,
          output: input.tool_response,
          sessionId: input.session_id,
          taskId,
        });
      }
      return {};
    };
  }
}
