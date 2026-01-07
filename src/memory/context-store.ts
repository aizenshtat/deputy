/**
 * Context Store - Long-term memory for people, projects, preferences, and knowledge
 */

import { ContextEntry } from '../types.js';
import { randomUUID } from 'crypto';

export class ContextStore {
  private entries: Map<string, ContextEntry> = new Map();
  private onChangeCallbacks: Array<() => void> = [];

  constructor(initialEntries: ContextEntry[] = []) {
    for (const entry of initialEntries) {
      this.entries.set(entry.id, entry);
    }
  }

  /**
   * Store a new context entry or update existing
   */
  upsert(params: {
    category: ContextEntry['category'];
    key: string;
    value: unknown;
    source: string;
    confidence?: number;
    tags?: string[];
  }): ContextEntry {
    // Check if entry with same category+key exists
    const existing = this.findByKey(params.category, params.key);

    if (existing) {
      existing.value = params.value;
      existing.updatedAt = new Date();
      existing.confidence = params.confidence ?? existing.confidence;
      if (params.tags) existing.tags = params.tags;
      this.notifyChange();
      return existing;
    }

    const entry: ContextEntry = {
      id: randomUUID(),
      category: params.category,
      key: params.key,
      value: params.value,
      source: params.source,
      createdAt: new Date(),
      updatedAt: new Date(),
      confidence: params.confidence ?? 0.8,
      tags: params.tags ?? [],
    };

    this.entries.set(entry.id, entry);
    this.notifyChange();
    return entry;
  }

  /**
   * Find entry by category and key
   */
  findByKey(category: ContextEntry['category'], key: string): ContextEntry | undefined {
    return Array.from(this.entries.values()).find(
      (e) => e.category === category && e.key === key
    );
  }

  /**
   * Get all entries in a category
   */
  getByCategory(category: ContextEntry['category']): ContextEntry[] {
    return Array.from(this.entries.values()).filter((e) => e.category === category);
  }

  /**
   * Search entries by tags
   */
  findByTags(tags: string[]): ContextEntry[] {
    return Array.from(this.entries.values()).filter((e) =>
      tags.some((tag) => e.tags.includes(tag))
    );
  }

  /**
   * Get all entries
   */
  getAllEntries(): ContextEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Build context summary for a specific domain
   */
  buildContextSummary(categories?: ContextEntry['category'][]): string {
    const entries = categories
      ? Array.from(this.entries.values()).filter((e) => categories.includes(e.category))
      : Array.from(this.entries.values());

    if (entries.length === 0) return 'No context available.';

    const grouped = new Map<string, ContextEntry[]>();
    for (const entry of entries) {
      const existing = grouped.get(entry.category) ?? [];
      existing.push(entry);
      grouped.set(entry.category, existing);
    }

    const lines: string[] = [];
    for (const [category, items] of grouped) {
      lines.push(`\n## ${category.charAt(0).toUpperCase() + category.slice(1)}:`);
      for (const item of items) {
        const valueStr = typeof item.value === 'string'
          ? item.value
          : JSON.stringify(item.value);
        lines.push(`- ${item.key}: ${valueStr}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Remove low-confidence entries
   */
  pruneByConfidence(threshold: number): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.confidence < threshold) {
        this.entries.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.notifyChange();
    return removed;
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
  toJSON(): ContextEntry[] {
    return Array.from(this.entries.values());
  }
}
