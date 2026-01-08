/**
 * Task Queue - Priority-based task management with persistence
 */

import { Task, TaskPriority, TaskStatus } from '../types.js';
import { randomUUID } from 'crypto';

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export class TaskQueue {
  private tasks: Map<string, Task> = new Map();
  private onChangeCallbacks: Array<() => void> = [];
  private onFailureCallbacks: Array<(task: Task) => void> = [];

  constructor(initialTasks: Task[] = []) {
    for (const task of initialTasks) {
      // Ensure logs field exists for backwards compatibility
      if (!task.logs) {
        task.logs = [];
      }
      this.tasks.set(task.id, task);
    }
  }

  /**
   * Add a new task to the queue
   */
  addTask(params: {
    title: string;
    description: string;
    priority?: TaskPriority;
    parentGoalId?: string;
    parentTaskId?: string;
    dueDate?: Date;
    context?: Record<string, unknown>;
    tags?: string[];
  }): Task {
    const task: Task = {
      id: randomUUID(),
      title: params.title,
      description: params.description,
      priority: params.priority ?? 'medium',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
      dueDate: params.dueDate,
      parentGoalId: params.parentGoalId,
      parentTaskId: params.parentTaskId,
      context: params.context ?? {},
      tags: params.tags ?? [],
      logs: [],
    };

    this.tasks.set(task.id, task);
    this.notifyChange();
    return task;
  }

  /**
   * Add a log entry to a task
   */
  addTaskLog(taskId: string, log: { type: 'info' | 'tool_use' | 'tool_result' | 'thinking' | 'error'; message: string; details?: Record<string, unknown> }): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.logs.push({
        timestamp: new Date(),
        ...log,
      });
      this.notifyChange();
    }
  }

  /**
   * Get the next task to work on (highest priority, oldest first)
   */
  getNextTask(): Task | undefined {
    const pendingTasks = this.getTasksByStatus('pending');
    if (pendingTasks.length === 0) return undefined;

    // Sort by priority, then by creation date
    pendingTasks.sort((a, b) => {
      const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    return pendingTasks[0];
  }

  /**
   * Get all tasks that can be worked on (not blocked by approvals)
   */
  getWorkableTasks(): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === 'pending' || t.status === 'approved'
    );
  }

  /**
   * Update a task's status
   */
  updateTaskStatus(taskId: string, status: TaskStatus, result?: string, error?: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    const wasNotFailed = task.status !== 'failed';
    task.status = status;
    task.updatedAt = new Date();
    if (result) task.result = result;
    if (error) task.error = error;

    // Notify failure callbacks if transitioning to failed state
    if (status === 'failed' && wasNotFailed) {
      for (const cb of this.onFailureCallbacks) {
        cb(task);
      }
    }

    this.notifyChange();
    return task;
  }

  /**
   * Update task with approval reference
   */
  setTaskApproval(taskId: string, approvalId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.approvalId = approvalId;
      task.status = 'waiting_approval';
      task.updatedAt = new Date();
      this.notifyChange();
    }
  }

  /**
   * Mark task as approved and ready to continue
   */
  approveTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'waiting_approval') {
      task.status = 'approved';
      task.updatedAt = new Date();
      this.notifyChange();
    }
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Update task with partial updates
   */
  updateTask(id: string, updates: Partial<Task>): void {
    const task = this.tasks.get(id);
    if (!task) return;

    Object.assign(task, updates);
    task.updatedAt = new Date();
    this.notifyChange();
  }

  /**
   * Get all tasks with a specific status
   */
  getTasksByStatus(status: TaskStatus): Task[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === status);
  }

  /**
   * Get all tasks for a goal
   */
  getTasksByGoal(goalId: string): Task[] {
    return Array.from(this.tasks.values()).filter((t) => t.parentGoalId === goalId);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Delete a task by ID
   */
  deleteTask(taskId: string): boolean {
    const deleted = this.tasks.delete(taskId);
    if (deleted) this.notifyChange();
    return deleted;
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    total: number;
    pending: number;
    inProgress: number;
    waitingApproval: number;
    completed: number;
    failed: number;
  } {
    const tasks = Array.from(this.tasks.values());
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      inProgress: tasks.filter((t) => t.status === 'in_progress').length,
      waitingApproval: tasks.filter((t) => t.status === 'waiting_approval').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
    };
  }

  /**
   * Subscribe to queue changes
   */
  onChange(callback: () => void): () => void {
    this.onChangeCallbacks.push(callback);
    return () => {
      const index = this.onChangeCallbacks.indexOf(callback);
      if (index >= 0) this.onChangeCallbacks.splice(index, 1);
    };
  }

  /**
   * Subscribe to task failures
   */
  onFailure(callback: (task: Task) => void): () => void {
    this.onFailureCallbacks.push(callback);
    return () => {
      const index = this.onFailureCallbacks.indexOf(callback);
      if (index >= 0) this.onFailureCallbacks.splice(index, 1);
    };
  }

  private notifyChange(): void {
    for (const cb of this.onChangeCallbacks) {
      cb();
    }
  }

  /**
   * Export all tasks for persistence
   */
  toJSON(): Task[] {
    return Array.from(this.tasks.values());
  }
}
