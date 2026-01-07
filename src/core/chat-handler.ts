/**
 * Chat Handler - Manages interactive communication with the principal
 */

import { ChatMessage } from '../types.js';
import { randomUUID } from 'crypto';

export type ChatCallback = (message: ChatMessage) => void | Promise<void>;

export class ChatHandler {
  private history: ChatMessage[] = [];
  private maxHistory = 100;
  private messageCallbacks: ChatCallback[] = [];

  /**
   * Add a user message
   */
  addUserMessage(content: string, relatedTaskIds?: string[], relatedApprovalIds?: string[]): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content,
      timestamp: new Date(),
      relatedTaskIds,
      relatedApprovalIds,
    };

    this.history.push(message);
    this.trimHistory();
    this.notifyCallbacks(message);

    return message;
  }

  /**
   * Add a deputy message
   */
  addDeputyMessage(content: string, relatedTaskIds?: string[], relatedApprovalIds?: string[]): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      role: 'deputy',
      content,
      timestamp: new Date(),
      relatedTaskIds,
      relatedApprovalIds,
    };

    this.history.push(message);
    this.trimHistory();
    this.notifyCallbacks(message);

    return message;
  }

  /**
   * Get recent chat history
   */
  getRecentHistory(limit = 20): ChatMessage[] {
    return this.history.slice(-limit);
  }

  /**
   * Get full history
   */
  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  /**
   * Build context string for agent
   */
  buildChatContext(limit = 10): string {
    const recent = this.getRecentHistory(limit);
    if (recent.length === 0) return '';

    return recent
      .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
      .join('\n\n');
  }

  /**
   * Subscribe to new messages
   */
  onMessage(callback: ChatCallback): () => void {
    this.messageCallbacks.push(callback);
    return () => {
      const index = this.messageCallbacks.indexOf(callback);
      if (index >= 0) this.messageCallbacks.splice(index, 1);
    };
  }

  /**
   * Clear chat history
   */
  clear(): void {
    this.history = [];
  }

  private trimHistory(): void {
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }

  private notifyCallbacks(message: ChatMessage): void {
    for (const cb of this.messageCallbacks) {
      Promise.resolve(cb(message)).catch(console.error);
    }
  }

  /**
   * Parse user input for special commands
   */
  parseCommand(input: string): { type: 'command' | 'message'; command?: string; args?: string; content: string } {
    const trimmed = input.trim();

    if (trimmed.startsWith('/')) {
      const spaceIndex = trimmed.indexOf(' ');
      if (spaceIndex === -1) {
        return { type: 'command', command: trimmed.slice(1), content: trimmed };
      }
      return {
        type: 'command',
        command: trimmed.slice(1, spaceIndex),
        args: trimmed.slice(spaceIndex + 1),
        content: trimmed,
      };
    }

    return { type: 'message', content: trimmed };
  }
}
