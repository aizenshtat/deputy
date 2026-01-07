/**
 * Approval Queue - Manages pending approvals without blocking execution
 */

import { ApprovalRequest, ApprovalStatus } from '../types.js';
import { randomUUID } from 'crypto';

export class ApprovalQueue {
  private approvals: Map<string, ApprovalRequest> = new Map();
  private onChangeCallbacks: Array<() => void> = [];

  constructor(initialApprovals: ApprovalRequest[] = []) {
    for (const approval of initialApprovals) {
      this.approvals.set(approval.id, approval);
    }
  }

  /**
   * Request approval for an action
   */
  requestApproval(params: {
    taskId: string;
    type: ApprovalRequest['type'];
    title: string;
    description: string;
    details: Record<string, unknown>;
    proposedAction: string;
    alternatives?: string[];
    risk: ApprovalRequest['risk'];
  }): ApprovalRequest {
    const approval: ApprovalRequest = {
      id: randomUUID(),
      taskId: params.taskId,
      type: params.type,
      title: params.title,
      description: params.description,
      details: params.details,
      proposedAction: params.proposedAction,
      alternatives: params.alternatives,
      risk: params.risk,
      status: 'pending',
      createdAt: new Date(),
    };

    this.approvals.set(approval.id, approval);
    this.notifyChange();
    return approval;
  }

  /**
   * Approve a request
   */
  approve(approvalId: string, notes?: string): ApprovalRequest | undefined {
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.status !== 'pending') return undefined;

    approval.status = 'approved';
    approval.respondedAt = new Date();
    approval.response = 'approved';
    if (notes) approval.notes = notes;

    this.notifyChange();
    return approval;
  }

  /**
   * Reject a request
   */
  reject(approvalId: string, reason: string): ApprovalRequest | undefined {
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.status !== 'pending') return undefined;

    approval.status = 'rejected';
    approval.respondedAt = new Date();
    approval.response = reason;

    this.notifyChange();
    return approval;
  }

  /**
   * Get all pending approvals
   */
  getPending(): ApprovalRequest[] {
    return Array.from(this.approvals.values())
      .filter((a) => a.status === 'pending')
      .sort((a, b) => {
        // Sort by risk (high first), then by creation date
        const riskOrder = { high: 0, medium: 1, low: 2 };
        const riskDiff = riskOrder[a.risk] - riskOrder[b.risk];
        if (riskDiff !== 0) return riskDiff;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
  }

  /**
   * Get approval by ID
   */
  getApproval(approvalId: string): ApprovalRequest | undefined {
    return this.approvals.get(approvalId);
  }

  /**
   * Get approval for a specific task
   */
  getApprovalForTask(taskId: string): ApprovalRequest | undefined {
    return Array.from(this.approvals.values()).find(
      (a) => a.taskId === taskId && a.status === 'pending'
    );
  }

  /**
   * Get all approvals
   */
  getAllApprovals(): ApprovalRequest[] {
    return Array.from(this.approvals.values());
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    byRisk: { low: number; medium: number; high: number };
  } {
    const approvals = Array.from(this.approvals.values());
    const pending = approvals.filter((a) => a.status === 'pending');

    return {
      total: approvals.length,
      pending: pending.length,
      approved: approvals.filter((a) => a.status === 'approved').length,
      rejected: approvals.filter((a) => a.status === 'rejected').length,
      byRisk: {
        low: pending.filter((a) => a.risk === 'low').length,
        medium: pending.filter((a) => a.risk === 'medium').length,
        high: pending.filter((a) => a.risk === 'high').length,
      },
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
  toJSON(): ApprovalRequest[] {
    return Array.from(this.approvals.values());
  }
}
