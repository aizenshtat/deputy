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
    fileModification: false,  // No Write/Edit tools anymore
    webActions: false,
    bashCommands: false,  // No Bash tool anymore
  },
  autoApprovePatterns: [
    'WebSearch',
    'WebFetch',
    // Note: Read/Glob/Grep/Bash removed - agents work in browser only
  ],
  blockPatterns: [
    // Legacy patterns - agents don't have Bash access anymore
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

    // Browser communication actions (sending messages, emails, etc.)
    if (toolName.includes('chrome-devtools') || toolName.includes('browser')) {
      const input = toolInput as any;

      // CRITICAL: ANY typing in messaging platforms requires approval
      if (toolName.includes('type') && input?.text) {
        // Check if we're in a messaging context by looking at snapshot or element
        const ref = input?.ref || '';
        const element = input?.element?.toLowerCase() || '';
        const text = input.text || '';

        // Slack, Gmail, or any messaging - ALWAYS require approval for typing messages
        if (element.includes('message') ||
            element.includes('compose') ||
            element.includes('chat') ||
            element.includes('dm') ||
            element.includes('slack') ||
            element.includes('mail') ||
            element.includes('email') ||
            ref.includes('message') ||
            ref.includes('compose') ||
            text.length > 50) {  // Any substantial typing
          return { needed: true, reason: 'Typing message in communication platform - requires approval', risk: 'high' };
        }
      }

      // CRITICAL: ANY clicking in messaging platforms requires approval
      if (toolName.includes('click')) {
        const element = input?.element?.toLowerCase() || '';
        const ref = input?.ref || '';

        // Send/submit/post buttons - ALWAYS require approval
        if (element.includes('send') ||
            element.includes('submit') ||
            element.includes('post') ||
            element.includes('share') ||
            ref.includes('send') ||
            ref.includes('submit')) {
          return { needed: true, reason: 'Clicking send/submit button - requires explicit approval', risk: 'high' };
        }

        // Any button/link in Slack messages - require approval
        if (element.includes('slack') ||
            element.includes('message') ||
            element.includes('chat') ||
            ref.includes('slack')) {
          return { needed: true, reason: 'Interaction in Slack - requires approval', risk: 'high' };
        }
      }

      // Navigation to messaging platforms is safe
      if (toolName.includes('navigate') && input?.url) {
        return { needed: false, risk: 'low' };
      }

      // All other browser actions are safe (reading pages, scrolling, etc.)
      return { needed: false, risk: 'low' };
    }

    // Note: Bash/Write/Edit tools removed - agent works in browser only
    // No filesystem or command checks needed

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
