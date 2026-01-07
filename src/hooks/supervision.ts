/**
 * Supervision Hook - Implements approval workflow for sensitive actions
 */

import { ApprovalQueue } from '../core/approval-queue.js';
import { TaskQueue } from '../core/task-queue.js';

export interface SupervisionConfig {
  requireApprovalFor: {
    externalCommunication: boolean;
    fileModification: boolean;
    webActions: boolean;
    bashCommands: boolean;
  };
  autoApprovePatterns: string[];
  blockPatterns: string[];
}

const DEFAULT_CONFIG: SupervisionConfig = {
  requireApprovalFor: {
    externalCommunication: true,
    fileModification: false,
    webActions: false,
    bashCommands: true,
  },
  autoApprovePatterns: [
    'Read',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
  ],
  blockPatterns: [
    'rm -rf',
    'sudo',
    'chmod 777',
  ],
};

export class SupervisionHook {
  private config: SupervisionConfig;
  private approvalQueue: ApprovalQueue;
  private taskQueue: TaskQueue;
  private currentTaskId?: string;

  constructor(
    approvalQueue: ApprovalQueue,
    taskQueue: TaskQueue,
    config: Partial<SupervisionConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.approvalQueue = approvalQueue;
    this.taskQueue = taskQueue;
  }

  setCurrentTask(taskId: string | undefined): void {
    this.currentTaskId = taskId;
  }

  /**
   * Determine if a tool use requires approval
   */
  private needsApproval(toolName: string, toolInput: unknown): { needed: boolean; reason?: string; risk: 'low' | 'medium' | 'high' } {
    // Check auto-approve patterns
    if (this.config.autoApprovePatterns.includes(toolName)) {
      return { needed: false, risk: 'low' };
    }

    // Check block patterns for Bash
    if (toolName === 'Bash') {
      const command = (toolInput as { command?: string })?.command ?? '';
      for (const pattern of this.config.blockPatterns) {
        if (command.includes(pattern)) {
          return { needed: true, reason: `Command contains blocked pattern: ${pattern}`, risk: 'high' };
        }
      }
      if (this.config.requireApprovalFor.bashCommands) {
        return { needed: true, reason: 'Bash command requires approval', risk: 'medium' };
      }
    }

    // File modifications
    if ((toolName === 'Write' || toolName === 'Edit') && this.config.requireApprovalFor.fileModification) {
      return { needed: true, reason: 'File modification requires approval', risk: 'medium' };
    }

    return { needed: false, risk: 'low' };
  }

  /**
   * Create PreToolUse hook that implements approval workflow
   */
  createPreToolUseHook() {
    return async (input: {
      hook_event_name: string;
      tool_name: string;
      tool_input: unknown;
      session_id: string;
    }) => {
      const { needed, reason, risk } = this.needsApproval(input.tool_name, input.tool_input);

      if (!needed) {
        return {};
      }

      // Create approval request
      const approval = this.approvalQueue.requestApproval({
        taskId: this.currentTaskId ?? 'unknown',
        type: 'action',
        title: `Approve ${input.tool_name}`,
        description: reason ?? `Tool ${input.tool_name} requires approval`,
        details: { toolInput: input.tool_input },
        proposedAction: `Execute ${input.tool_name}`,
        risk,
      });

      // Update task status
      if (this.currentTaskId) {
        this.taskQueue.setTaskApproval(this.currentTaskId, approval.id);
      }

      // Block execution pending approval
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: `Pending approval: ${approval.id}`,
        },
      };
    };
  }
}
