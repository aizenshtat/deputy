/**
 * Responsibility Manager - Tracks ongoing areas of work
 *
 * A responsibility is an ongoing commitment that may have:
 * - A domain (project, executive, recruiting, etc.)
 * - Phases (planning, active, review, etc.)
 * - Cadences (daily standup, weekly sync, etc.)
 * - Associated people and channels
 * - Accumulated context
 */

import { randomUUID } from 'crypto';

export interface Cadence {
  id: string;
  name: string; // "daily standup", "weekly board prep", "sprint planning"
  schedule: CadenceSchedule;
  lastTriggered?: Date;
  nextDue?: Date;
  context?: string; // What to do when triggered
}

export type CadenceSchedule =
  | { type: 'daily'; time?: string } // "09:00"
  | { type: 'weekly'; day: number; time?: string } // day: 0=Sun, 1=Mon, etc.
  | { type: 'biweekly'; day: number; time?: string }
  | { type: 'monthly'; dayOfMonth: number; time?: string }
  | { type: 'relative'; trigger: 'before' | 'after'; days: number; reference: string } // "3 days before meeting"
  | { type: 'manual' }; // Only triggered explicitly

export interface Person {
  id: string;
  name: string;
  role?: string;
  slack?: string; // Slack handle or DM identifier
  email?: string;
  notes?: string;
}

export interface Responsibility {
  id: string;
  name: string;
  description: string;
  domain: string; // 'project' | 'executive' | 'recruiting' | 'operations' | custom

  // Current state
  status: 'active' | 'paused' | 'completed';
  phase?: string; // Domain-specific phase (e.g., "planning", "active", "review")
  phaseStartedAt?: Date;

  // Scheduling
  cadences: Cadence[];

  // People involved
  people: Person[];

  // External references
  channels: {
    slack?: string; // Slack channel
    jira?: string; // Jira project key
    confluence?: string; // Confluence space
    calendar?: string; // Calendar ID or meeting name
    drive?: string; // Google Drive folder
  };

  // Context - accumulated knowledge about this responsibility
  context: string; // Free-form notes, preferences, history
  recentActivity: ActivityEntry[];

  // Metadata
  createdAt: Date;
  updatedAt: Date;
  lastAttendedAt?: Date; // Last time deputy did something for this
}

export interface ActivityEntry {
  timestamp: Date;
  type: 'task_created' | 'task_completed' | 'note_added' | 'phase_changed' | 'cadence_triggered';
  summary: string;
  taskId?: string;
}

export class ResponsibilityManager {
  private responsibilities: Map<string, Responsibility> = new Map();
  private onChangeCallbacks: Array<() => void> = [];

  constructor(initial: Responsibility[] = []) {
    for (const r of initial) {
      // Restore dates
      r.createdAt = new Date(r.createdAt);
      r.updatedAt = new Date(r.updatedAt);
      if (r.lastAttendedAt) r.lastAttendedAt = new Date(r.lastAttendedAt);
      if (r.phaseStartedAt) r.phaseStartedAt = new Date(r.phaseStartedAt);
      for (const c of r.cadences) {
        if (c.lastTriggered) c.lastTriggered = new Date(c.lastTriggered);
        if (c.nextDue) c.nextDue = new Date(c.nextDue);
      }
      for (const a of r.recentActivity) {
        a.timestamp = new Date(a.timestamp);
      }
      this.responsibilities.set(r.id, r);
    }
  }

  /**
   * Create a new responsibility
   */
  create(params: {
    name: string;
    description: string;
    domain: string;
    phase?: string;
    cadences?: Omit<Cadence, 'id'>[];
    people?: Person[];
    channels?: Responsibility['channels'];
    context?: string;
  }): Responsibility {
    const now = new Date();

    const responsibility: Responsibility = {
      id: randomUUID(),
      name: params.name,
      description: params.description,
      domain: params.domain,
      status: 'active',
      phase: params.phase,
      phaseStartedAt: params.phase ? now : undefined,
      cadences: (params.cadences ?? []).map((c) => ({ ...c, id: randomUUID() })),
      people: params.people ?? [],
      channels: params.channels ?? {},
      context: params.context ?? '',
      recentActivity: [],
      createdAt: now,
      updatedAt: now,
    };

    // Calculate next due dates for cadences
    for (const cadence of responsibility.cadences) {
      cadence.nextDue = this.calculateNextDue(cadence.schedule, now);
    }

    this.responsibilities.set(responsibility.id, responsibility);
    this.notifyChange();
    return responsibility;
  }

  /**
   * Get a responsibility by ID
   */
  get(id: string): Responsibility | undefined {
    return this.responsibilities.get(id);
  }

  /**
   * Get all active responsibilities
   */
  getActive(): Responsibility[] {
    return Array.from(this.responsibilities.values()).filter((r) => r.status === 'active');
  }

  /**
   * Get all responsibilities
   */
  getAll(): Responsibility[] {
    return Array.from(this.responsibilities.values());
  }

  /**
   * Find responsibilities by domain
   */
  getByDomain(domain: string): Responsibility[] {
    return this.getActive().filter((r) => r.domain === domain);
  }

  /**
   * Update a responsibility
   */
  update(id: string, updates: Partial<Omit<Responsibility, 'id' | 'createdAt'>>): Responsibility | undefined {
    const r = this.responsibilities.get(id);
    if (!r) return undefined;

    Object.assign(r, updates, { updatedAt: new Date() });
    this.notifyChange();
    return r;
  }

  /**
   * Change phase
   */
  setPhase(id: string, phase: string): void {
    const r = this.responsibilities.get(id);
    if (r) {
      const oldPhase = r.phase;
      r.phase = phase;
      r.phaseStartedAt = new Date();
      r.updatedAt = new Date();
      this.addActivity(id, 'phase_changed', `Phase changed: ${oldPhase ?? 'none'} → ${phase}`);
      this.notifyChange();
    }
  }

  /**
   * Add context/notes
   */
  addContext(id: string, note: string): void {
    const r = this.responsibilities.get(id);
    if (r) {
      r.context += (r.context ? '\n\n' : '') + `[${new Date().toISOString()}] ${note}`;
      r.updatedAt = new Date();
      this.addActivity(id, 'note_added', note.slice(0, 100));
      this.notifyChange();
    }
  }

  /**
   * Add activity entry
   */
  addActivity(id: string, type: ActivityEntry['type'], summary: string, taskId?: string): void {
    const r = this.responsibilities.get(id);
    if (r) {
      r.recentActivity.unshift({
        timestamp: new Date(),
        type,
        summary,
        taskId,
      });
      // Keep only last 50 activities
      if (r.recentActivity.length > 50) {
        r.recentActivity = r.recentActivity.slice(0, 50);
      }
    }
  }

  /**
   * Mark as attended (deputy did something for this)
   */
  markAttended(id: string): void {
    const r = this.responsibilities.get(id);
    if (r) {
      r.lastAttendedAt = new Date();
      r.updatedAt = new Date();
      this.notifyChange();
    }
  }

  /**
   * Add a person to a responsibility
   */
  addPerson(id: string, person: Person): void {
    const r = this.responsibilities.get(id);
    if (r && !r.people.find((p) => p.id === person.id)) {
      r.people.push(person);
      r.updatedAt = new Date();
      this.notifyChange();
    }
  }

  /**
   * Add a cadence
   */
  addCadence(id: string, cadence: Omit<Cadence, 'id'>): Cadence | undefined {
    const r = this.responsibilities.get(id);
    if (r) {
      const newCadence: Cadence = {
        ...cadence,
        id: randomUUID(),
        nextDue: this.calculateNextDue(cadence.schedule, new Date()),
      };
      r.cadences.push(newCadence);
      r.updatedAt = new Date();
      this.notifyChange();
      return newCadence;
    }
    return undefined;
  }

  /**
   * Mark a cadence as triggered and calculate next due
   */
  triggerCadence(responsibilityId: string, cadenceId: string): void {
    const r = this.responsibilities.get(responsibilityId);
    if (r) {
      const cadence = r.cadences.find((c) => c.id === cadenceId);
      if (cadence) {
        const now = new Date();
        cadence.lastTriggered = now;
        cadence.nextDue = this.calculateNextDue(cadence.schedule, now);
        r.updatedAt = now;
        this.addActivity(responsibilityId, 'cadence_triggered', cadence.name);
        this.notifyChange();
      }
    }
  }

  /**
   * Get all cadences that are due
   */
  getDueCadences(): Array<{ responsibility: Responsibility; cadence: Cadence }> {
    const now = new Date();
    const due: Array<{ responsibility: Responsibility; cadence: Cadence }> = [];

    for (const r of this.getActive()) {
      for (const c of r.cadences) {
        if (c.nextDue && c.nextDue <= now) {
          due.push({ responsibility: r, cadence: c });
        }
      }
    }

    return due;
  }

  /**
   * Get responsibilities needing attention (no recent activity)
   */
  getNeedingAttention(hoursThreshold = 24): Responsibility[] {
    const threshold = new Date(Date.now() - hoursThreshold * 60 * 60 * 1000);

    return this.getActive().filter((r) => {
      return !r.lastAttendedAt || r.lastAttendedAt < threshold;
    });
  }

  /**
   * Calculate next due date for a cadence
   */
  private calculateNextDue(schedule: CadenceSchedule, from: Date): Date | undefined {
    const next = new Date(from);

    switch (schedule.type) {
      case 'daily': {
        next.setDate(next.getDate() + 1);
        if (schedule.time) {
          const [h, m] = schedule.time.split(':').map(Number);
          next.setHours(h, m, 0, 0);
        }
        return next;
      }

      case 'weekly': {
        const daysUntil = (schedule.day - next.getDay() + 7) % 7 || 7;
        next.setDate(next.getDate() + daysUntil);
        if (schedule.time) {
          const [h, m] = schedule.time.split(':').map(Number);
          next.setHours(h, m, 0, 0);
        }
        return next;
      }

      case 'biweekly': {
        const daysUntil = (schedule.day - next.getDay() + 7) % 7 || 7;
        next.setDate(next.getDate() + daysUntil + 7); // Add extra week for biweekly
        if (schedule.time) {
          const [h, m] = schedule.time.split(':').map(Number);
          next.setHours(h, m, 0, 0);
        }
        return next;
      }

      case 'monthly': {
        next.setMonth(next.getMonth() + 1);
        next.setDate(schedule.dayOfMonth);
        if (schedule.time) {
          const [h, m] = schedule.time.split(':').map(Number);
          next.setHours(h, m, 0, 0);
        }
        return next;
      }

      case 'relative':
        // Relative schedules need external reference, can't calculate statically
        return undefined;

      case 'manual':
        return undefined;
    }
  }

  /**
   * Pause a responsibility
   */
  pause(id: string): void {
    const r = this.responsibilities.get(id);
    if (r) {
      r.status = 'paused';
      r.updatedAt = new Date();
      this.notifyChange();
    }
  }

  /**
   * Resume a responsibility
   */
  resume(id: string): void {
    const r = this.responsibilities.get(id);
    if (r && r.status === 'paused') {
      r.status = 'active';
      r.updatedAt = new Date();
      this.notifyChange();
    }
  }

  /**
   * Complete a responsibility
   */
  complete(id: string): void {
    const r = this.responsibilities.get(id);
    if (r) {
      r.status = 'completed';
      r.updatedAt = new Date();
      this.notifyChange();
    }
  }

  /**
   * Delete a responsibility
   */
  delete(id: string): boolean {
    const deleted = this.responsibilities.delete(id);
    if (deleted) this.notifyChange();
    return deleted;
  }

  /**
   * Subscribe to changes
   */
  onChange(callback: () => void): () => void {
    this.onChangeCallbacks.push(callback);
    return () => {
      const idx = this.onChangeCallbacks.indexOf(callback);
      if (idx >= 0) this.onChangeCallbacks.splice(idx, 1);
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
  toJSON(): Responsibility[] {
    return Array.from(this.responsibilities.values());
  }

  /**
   * Get stats
   */
  getStats(): { total: number; active: number; byDomain: Record<string, number> } {
    const all = this.getAll();
    const active = this.getActive();
    const byDomain: Record<string, number> = {};

    for (const r of active) {
      byDomain[r.domain] = (byDomain[r.domain] ?? 0) + 1;
    }

    return { total: all.length, active: active.length, byDomain };
  }
}
