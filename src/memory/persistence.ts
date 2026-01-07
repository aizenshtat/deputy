/**
 * Persistence Layer - Save and load state to disk
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { Task, Goal, ApprovalRequest, ContextEntry, DeputyState } from '../types.js';
import { Responsibility } from './responsibilities.js';

export interface PersistedData {
  tasks: Task[];
  goals: Goal[];
  approvals: ApprovalRequest[];
  context: ContextEntry[];
  responsibilities: Responsibility[];
  state: DeputyState;
  lastSaved: string;
}

export class Persistence {
  private dataDir: string;
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Initialize data directory
   */
  async init(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      await mkdir(this.dataDir, { recursive: true });
    }
  }

  /**
   * Load all persisted data
   */
  async load(): Promise<PersistedData | null> {
    const filePath = join(this.dataDir, 'deputy-state.json');

    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content) as PersistedData;

      // Rehydrate dates
      for (const task of data.tasks) {
        task.createdAt = new Date(task.createdAt);
        task.updatedAt = new Date(task.updatedAt);
        if (task.dueDate) task.dueDate = new Date(task.dueDate);
      }

      for (const goal of data.goals) {
        goal.createdAt = new Date(goal.createdAt);
        goal.updatedAt = new Date(goal.updatedAt);
      }

      for (const approval of data.approvals) {
        approval.createdAt = new Date(approval.createdAt);
        if (approval.respondedAt) approval.respondedAt = new Date(approval.respondedAt);
      }

      for (const ctx of data.context) {
        ctx.createdAt = new Date(ctx.createdAt);
        ctx.updatedAt = new Date(ctx.updatedAt);
      }

      data.state.lastActivity = new Date(data.state.lastActivity);

      return data;
    } catch (error) {
      console.error('Failed to load persisted data:', error);
      return null;
    }
  }

  /**
   * Save all data (debounced to avoid excessive writes)
   */
  save(data: PersistedData): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    this.saveDebounceTimer = setTimeout(() => {
      this.saveImmediate(data).catch(console.error);
    }, 1000);
  }

  /**
   * Force immediate save
   */
  async saveImmediate(data: PersistedData): Promise<void> {
    const filePath = join(this.dataDir, 'deputy-state.json');
    data.lastSaved = new Date().toISOString();

    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Export data for backup
   */
  async exportBackup(): Promise<string> {
    const data = await this.load();
    if (!data) throw new Error('No data to export');

    const backupPath = join(this.dataDir, `backup-${Date.now()}.json`);
    await writeFile(backupPath, JSON.stringify(data, null, 2), 'utf-8');

    return backupPath;
  }
}
