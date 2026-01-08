/**
 * Goal Manager - High-level goal tracking and decomposition
 */

import { Goal, TaskPriority } from '../types.js';
import { randomUUID } from 'crypto';

export class GoalManager {
  private goals: Map<string, Goal> = new Map();
  private onChangeCallbacks: Array<() => void> = [];

  constructor(initialGoals: Goal[] = []) {
    for (const goal of initialGoals) {
      this.goals.set(goal.id, goal);
    }
  }

  /**
   * Create a new goal
   */
  createGoal(params: {
    title: string;
    description: string;
    priority?: TaskPriority;
    context?: Record<string, unknown>;
    tags?: string[];
  }): Goal {
    const goal: Goal = {
      id: randomUUID(),
      title: params.title,
      description: params.description,
      priority: params.priority ?? 'medium',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      taskIds: [],
      progress: 0,
      context: params.context ?? {},
      tags: params.tags ?? [],
    };

    this.goals.set(goal.id, goal);
    this.notifyChange();
    return goal;
  }

  /**
   * Add a task to a goal
   */
  addTaskToGoal(goalId: string, taskId: string): void {
    const goal = this.goals.get(goalId);
    if (goal && !goal.taskIds.includes(taskId)) {
      goal.taskIds.push(taskId);
      goal.updatedAt = new Date();
      this.notifyChange();
    }
  }

  /**
   * Update goal progress based on task completion
   */
  updateProgress(goalId: string, completedTasks: number, totalTasks: number): void {
    const goal = this.goals.get(goalId);
    if (goal) {
      goal.progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
      goal.updatedAt = new Date();

      if (goal.progress === 100) {
        goal.status = 'completed';
      }

      this.notifyChange();
    }
  }

  /**
   * Get goal by ID
   */
  getGoal(goalId: string): Goal | undefined {
    return this.goals.get(goalId);
  }

  /**
   * Get all active goals
   */
  getActiveGoals(): Goal[] {
    return Array.from(this.goals.values())
      .filter((g) => g.status === 'active')
      .sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
  }

  /**
   * Get all goals
   */
  getAllGoals(): Goal[] {
    return Array.from(this.goals.values());
  }

  /**
   * Pause a goal
   */
  pauseGoal(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (goal) {
      goal.status = 'paused';
      goal.updatedAt = new Date();
      this.notifyChange();
    }
  }

  /**
   * Resume a paused goal
   */
  resumeGoal(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (goal && goal.status === 'paused') {
      goal.status = 'active';
      goal.updatedAt = new Date();
      this.notifyChange();
    }
  }

  /**
   * Cancel a goal
   */
  cancelGoal(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (goal) {
      goal.status = 'cancelled';
      goal.updatedAt = new Date();
      this.notifyChange();
    }
  }

  /**
   * Delete a goal
   */
  deleteGoal(goalId: string): boolean {
    const deleted = this.goals.delete(goalId);
    if (deleted) this.notifyChange();
    return deleted;
  }

  /**
   * Update a goal with partial updates
   */
  updateGoal(goalId: string, updates: Partial<Omit<Goal, 'id' | 'createdAt'>>): Goal | undefined {
    const goal = this.goals.get(goalId);
    if (!goal) return undefined;

    Object.assign(goal, updates, { updatedAt: new Date() });
    this.notifyChange();
    return goal;
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    active: number;
    completed: number;
    paused: number;
    averageProgress: number;
  } {
    const goals = Array.from(this.goals.values());
    const active = goals.filter((g) => g.status === 'active');

    return {
      total: goals.length,
      active: active.length,
      completed: goals.filter((g) => g.status === 'completed').length,
      paused: goals.filter((g) => g.status === 'paused').length,
      averageProgress: active.length > 0
        ? Math.round(active.reduce((sum, g) => sum + g.progress, 0) / active.length)
        : 0,
    };
  }

  /**
   * Subscribe to changes
   */
  onChange(callback: () => void): () => void {
    this.onChangeCallbacks.push(callback);
    return () => {
      const index = this.onChangeCallbacks.indexOf(callback);
      if (index >= 0) this.onChangeCallbacks.splice(index, 1);
    };
  }

  private notifyChange(): void {
    for (const cb of this.onChangeCallbacks) {
      cb();
    }
  }

  /**
   * Export for persistence
   */
  toJSON(): Goal[] {
    return Array.from(this.goals.values());
  }
}
