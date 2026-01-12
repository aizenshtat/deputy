/**
 * Deputy - Main Orchestrator
 *
 * The central coordinator that:
 * - Runs the continuous agent loop
 * - Manages task execution
 * - Handles approvals without blocking
 * - Processes user chat
 * - Persists state
 */

import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TaskQueue } from './task-queue.js';
import { ApprovalQueue } from './approval-queue.js';
import { ChatHandler } from './chat-handler.js';
import { AutonomousScanner } from './autonomous-scanner.js';
import { ContextStore } from '../memory/context-store.js';
import { GoalManager } from '../memory/goals.js';
import { ResponsibilityManager, Responsibility } from '../memory/responsibilities.js';
import { Persistence, PersistedData } from '../memory/persistence.js';
import { AuditLog } from '../hooks/audit-log.js';
import { SupervisionHook } from '../hooks/supervision.js';
import { getAgentDefinitions } from '../agents/index.js';
import { ApprovalRequest } from '../types.js';
import { buildSystemPrompt, buildTaskPrompt } from '../config/system-prompt.js';
import { DeputyState, DeputyConfig, Task, ContextEntry } from '../types.js';
import { colors, statusSymbols, renderMarkdown } from '../utils/colors.js';
import { StatusBar, formatTaskStatus } from '../utils/status-bar.js';

const DEFAULT_CONFIG: DeputyConfig = {
  workingDirectory: process.cwd(),
  dataDirectory: './data',
  pollingIntervalMs: 5000,
  maxConcurrentTasks: 1,
  autoApproveThreshold: 'none',
  notificationPreferences: {
    approvalNeeded: true,
    taskCompleted: true,
    errors: true,
  },
};

export class Deputy {
  private config: DeputyConfig;
  private taskQueue: TaskQueue;
  private approvalQueue: ApprovalQueue;
  private chatHandler: ChatHandler;
  private contextStore: ContextStore;
  private goalManager: GoalManager;
  private responsibilityManager: ResponsibilityManager;
  private autonomousScanner: AutonomousScanner;
  private persistence: Persistence;
  private auditLog: AuditLog;
  private supervisionHook: SupervisionHook;
  private statusBar: StatusBar;

  private state: DeputyState = {
    isRunning: false,
    lastActivity: new Date(),
    stats: {
      tasksCompleted: 0,
      tasksInProgress: 0,
      pendingApprovals: 0,
      activeGoals: 0,
      activeResponsibilities: 0,
    },
  };

  private loopAbortController: AbortController | null = null;
  private currentSessionId: string | undefined;

  constructor(config: Partial<DeputyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize components
    this.taskQueue = new TaskQueue();
    this.approvalQueue = new ApprovalQueue();
    this.chatHandler = new ChatHandler();
    this.contextStore = new ContextStore();
    this.goalManager = new GoalManager();
    this.responsibilityManager = new ResponsibilityManager();
    this.persistence = new Persistence(this.config.dataDirectory);
    this.auditLog = new AuditLog(this.config.dataDirectory);
    this.supervisionHook = new SupervisionHook(this.approvalQueue, this.taskQueue);
    this.statusBar = new StatusBar();

    // Initialize autonomous scanner (planning now done inline in deputy.ts)
    this.autonomousScanner = new AutonomousScanner({
      responsibilityManager: this.responsibilityManager,
      taskQueue: this.taskQueue,
      contextStore: this.contextStore,
      goalManager: this.goalManager,
      scanIntervalMs: 30 * 60 * 1000, // 30 minutes
    });

    // Set up change listeners for auto-save
    this.taskQueue.onChange(() => this.saveState());
    this.approvalQueue.onChange(() => this.saveState());
    this.contextStore.onChange(() => this.saveState());
    this.goalManager.onChange(() => this.saveState());
    this.responsibilityManager.onChange(() => this.saveState());
  }

  /**
   * Initialize and load persisted state
   */
  async init(): Promise<void> {
    await this.persistence.init();
    await this.auditLog.init();

    const data = await this.persistence.load();
    if (data) {
      this.taskQueue = new TaskQueue(data.tasks);
      this.approvalQueue = new ApprovalQueue(data.approvals);
      this.contextStore = new ContextStore(data.context);
      this.goalManager = new GoalManager(data.goals);
      this.responsibilityManager = new ResponsibilityManager(data.responsibilities ?? []);
      this.state = data.state;

      // Reset isRunning flag - should always start as false when loading from disk
      this.state.isRunning = false;

      // Restore session ID for conversation continuity (enables task resumption)
      this.currentSessionId = data.state.sessionId;

      // Detect and recover stuck tasks
      this.recoverStuckTasks();

      // Report if there's a task to resume
      if (this.state.currentTaskId) {
        const task = this.taskQueue.getTask(this.state.currentTaskId);
        if (task && task.status === 'in_progress') {
          console.log(colors.info(`\n⏯️  Resuming task from previous session: ${colors.bold(task.title)} (${task.id.slice(0, 8)})\n`));
        }
      }

      // Re-attach change listeners
      this.taskQueue.onChange(() => this.saveState());
      this.approvalQueue.onChange(() => this.saveState());
      this.contextStore.onChange(() => this.saveState());
      this.goalManager.onChange(() => this.saveState());
      this.responsibilityManager.onChange(() => this.saveState());

      // Subscribe to task failures for notifications
      this.taskQueue.onFailure((task) => {
        console.log(colors.error(`\n${statusSymbols.error} TASK FAILED: ${task.title}`));
        console.log(colors.dim(`   ID: ${task.id.slice(0, 8)}`));
        if (task.error) {
          console.log(colors.error(`   Error: ${task.error.slice(0, 200)}`));
        }
        console.log(colors.info(`   Use /tasks to see all tasks\n`));
      });

      // Re-create supervision hook with restored queues
      this.supervisionHook = new SupervisionHook(this.approvalQueue, this.taskQueue);

      // Re-create autonomous scanner with restored managers
      this.autonomousScanner = new AutonomousScanner({
        responsibilityManager: this.responsibilityManager,
        taskQueue: this.taskQueue,
        contextStore: this.contextStore,
        goalManager: this.goalManager,
        scanIntervalMs: 30 * 60 * 1000, // 30 minutes
      });

      console.log('Restored state from disk');
    }

    this.updateStats();
  }

  /**
   * Start the continuous operation loop
   */
  async start(): Promise<void> {
    if (this.state.isRunning) {
      console.log('Deputy is already running');
      return;
    }

    this.state.isRunning = true;
    this.loopAbortController = new AbortController();

    console.log('Deputy started. Running continuous loop...');

    await this.runLoop();
  }

  /**
   * Stop the agent gracefully
   */
  async stop(): Promise<void> {
    this.state.isRunning = false;
    this.loopAbortController?.abort();
    this.loopAbortController = null;

    // Add shutdown log to current task if one is running (will resume on restart)
    if (this.state.currentTaskId) {
      const task = this.taskQueue.getTask(this.state.currentTaskId);
      if (task && task.status === 'in_progress') {
        this.taskQueue.addTaskLog(this.state.currentTaskId, {
          type: 'info',
          message: 'System shutdown - task will resume on next startup'
        });
        console.log(colors.dim(`\n  Task "${task.title}" will resume when Deputy restarts\n`));
      }
    }

    // Save final state (preserves in_progress status for resumption)
    await this.saveState();
    console.log('Deputy stopped gracefully');
  }

  /**
   * Main execution loop
   */
  private async runLoop(): Promise<void> {
    let idleLogged = false;
    let idleCycles = 0;
    const IDLE_HEARTBEAT_CYCLES = 12; // Every ~60s with 5s polling (or ~120s with 10s)

    while (this.state.isRunning) {
      try {
        // Priority 1: Resume in-progress task if one exists
        let taskToExecute: Task | undefined;
        if (this.state.currentTaskId) {
          const currentTask = this.taskQueue.getTask(this.state.currentTaskId);
          if (currentTask && currentTask.status === 'in_progress') {
            taskToExecute = currentTask;
          }
        }

        // Priority 2: Check for new pending tasks
        if (!taskToExecute) {
          taskToExecute = this.taskQueue.getNextTask();
        }

        // Priority 3: Check for approved tasks
        if (!taskToExecute) {
          const approvedTasks = this.taskQueue.getTasksByStatus('approved');
          if (approvedTasks.length > 0) {
            taskToExecute = approvedTasks[0];
          }
        }

        // Priority 4: Handle rejected approvals (learn from rejections)
        if (!taskToExecute) {
          await this.handleRejectedApprovals();
        }

        if (taskToExecute) {
          idleLogged = false;
          idleCycles = 0;
          await this.executeTask(taskToExecute);
        } else {
          // Check if it's time to plan (scanner logic moved inline)
          if (this.autonomousScanner.shouldScan()) {
            idleLogged = false;
            idleCycles = 0;
            await this.planNewWork();
          }

          idleCycles++;

          // First idle message
          if (!idleLogged) {
            const stats = this.taskQueue.getStats();
            const approvals = this.approvalQueue.getStats();
            const respStats = this.responsibilityManager.getStats();

            if (stats.waitingApproval > 0 || approvals.pending > 0) {
              console.log(
                colors.warning(
                  `\n${statusSymbols.warning} [IDLE] Waiting for ${colors.bold(approvals.pending.toString())} approval(s). Use ${colors.info('/approvals')} to review.\n`
                )
              );
            } else if (respStats.active > 0) {
              console.log(
                colors.info(
                  `\n${statusSymbols.info} [IDLE] Monitoring ${colors.bold(respStats.active.toString())} responsibility(ies). Next scan: ${this.autonomousScanner.getNextScanTime().toLocaleTimeString()}\n`
                )
              );
            } else {
              console.log(
                colors.dim(
                  `\n${statusSymbols.pending} [IDLE] No tasks or responsibilities. Use ${colors.info('/responsibility')} to add ongoing work.\n`
                )
              );
            }
            idleLogged = true;
          }

          // Periodic heartbeat
          if (idleCycles % IDLE_HEARTBEAT_CYCLES === 0) {
            console.log(colors.dim(`[${new Date().toLocaleTimeString()}] Still monitoring...`));
          }
        }

        // Update stats
        this.updateStats();

        // Wait before next iteration
        await this.sleep(this.config.pollingIntervalMs);
      } catch (error) {
        console.error(colors.error('Error in main loop:'), error);
        await this.sleep(this.config.pollingIntervalMs);
      }
    }
  }

  /**
   * Detect and recover stuck tasks on startup
   * A task is stuck if it's been in_progress for >10 minutes with no updates
   * Also auto-retry failed tasks caused by tool errors
   */
  private recoverStuckTasks(): void {
    const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    const now = Date.now();

    // Handle stuck in_progress tasks
    const inProgressTasks = this.taskQueue.getTasksByStatus('in_progress');

    for (const task of inProgressTasks) {
      const timeSinceUpdate = now - task.updatedAt.getTime();

      if (timeSinceUpdate > STUCK_THRESHOLD_MS) {
        console.log(colors.warning(`\n⚠️  Detected stuck task: ${colors.bold(task.title)} (${task.id.slice(0, 8)})`));
        console.log(colors.dim(`   Last updated: ${Math.round(timeSinceUpdate / 60000)} minutes ago`));

        // Clear the session ID to force a fresh start
        if (this.currentSessionId && this.state.currentTaskId === task.id) {
          console.log(colors.info(`   Restarting task with fresh session...\n`));
          this.currentSessionId = undefined;
          this.state.sessionId = undefined;
        } else {
          // Not the current task, reset it to pending
          console.log(colors.info(`   Resetting task to pending...\n`));
          this.taskQueue.updateTaskStatus(task.id, 'pending');
        }

        // Add a log entry about the recovery
        this.taskQueue.addTaskLog(task.id, {
          type: 'info',
          message: `⚠️ Task was stuck (no activity for ${Math.round(timeSinceUpdate / 60000)} minutes). Auto-restarted with fresh session.`
        });
      }
    }

    // Handle failed tasks that can be auto-retried (tool errors that might be fixed now)
    const failedTasks = this.taskQueue.getTasksByStatus('failed');

    for (const task of failedTasks) {
      if (task.error && task.error.includes('Tool error:')) {
        console.log(colors.info(`\n🔄 Auto-retrying failed task (tool error fixed): ${colors.bold(task.title)} (${task.id.slice(0, 8)})`));
        this.taskQueue.updateTaskStatus(task.id, 'pending');
        this.taskQueue.addTaskLog(task.id, {
          type: 'info',
          message: 'Auto-retrying task after tool availability was restored'
        });
      }
    }
  }

  /**
   * Handle rejected approvals - fail tasks and learn from rejection reasoning
   */
  private async handleRejectedApprovals(): Promise<void> {
    // Get all rejected approvals
    const rejectedApprovals = this.approvalQueue.getAllApprovals().filter((a: ApprovalRequest) => a.status === 'rejected');

    for (const approval of rejectedApprovals) {
      // Find the task associated with this approval
      const task = this.taskQueue.getAllTasks().find(t =>
        t.status === 'waiting_approval' &&
        (t.approvalId === approval.id || t.id === approval.taskId)
      );

      if (task) {
        console.log(colors.warning(`\n⚠️  Handling rejected approval for task: ${colors.bold(task.title)} (${task.id.slice(0, 8)})`));
        console.log(colors.dim(`   Rejection reason: ${approval.rejectionReason}`));

        // Store the rejection as context (learning)
        this.contextStore.upsert({
          category: 'decision',
          key: `rejection_${task.id.slice(0, 8)}_${Date.now()}`,
          value: `Rejected task "${task.title}": ${approval.rejectionReason}`,
          source: 'user_rejection',
          tags: ['rejection', 'learning'],
          confidence: 0.9
        });

        // Fail the task with the rejection reason
        this.taskQueue.updateTaskStatus(
          task.id,
          'failed',
          undefined,
          `Rejected by user: ${approval.rejectionReason}`
        );

        this.taskQueue.addTaskLog(task.id, {
          type: 'error',
          message: `Task rejected by user: ${approval.rejectionReason}`
        });

        console.log(colors.info(`   Stored rejection reasoning as context for future learning\n`));
      }

      // Remove the processed rejection
      this.approvalQueue.deleteApproval(approval.id);
    }
  }

  /**
   * Plan new work - runs inline (no subprocess) to avoid MCP communication issues
   */
  private async planNewWork(): Promise<void> {
    console.log('[SCAN] Starting autonomous planning...');

    const prompt = this.autonomousScanner.buildPlanningPrompt();

    // If nothing to plan, skip
    if (!prompt) {
      console.log('[SCAN] Nothing needs attention');
      this.autonomousScanner.markScanned();
      return;
    }

    try {
      // Use same query() as task execution - works because same process
      for await (const message of query({
        prompt,
        options: {
          systemPrompt: `You are Deputy's autonomous planning assistant.

## When to CREATE tasks (do it)
- Due cadences with clear actions (e.g., "weekly standup prep" → create prep task)
- Follow-up tasks from completed work (e.g., research done → create action task)
- Specific, actionable work that's obvious from context

## When to ASK questions (don't assume)
- Unclear priorities between competing responsibilities
- New initiatives without clear direction
- Strategic decisions that need user input

## What NOT to do
- Don't create generic "Create Google Doc with X" tasks
- Don't create tasks just because a responsibility exists
- Don't spam multiple similar tasks

Be selective. Quality over quantity. If unsure, ask. If clear, act.`,
          cwd: this.config.workingDirectory,
          model: this.config.model,
          mcpServers: {
            "deputy-tools": this.createDeputyTools()
          },
          allowedTools: [
            'mcp__deputy-tools__*', // All deputy tools for planning
            'WebFetch', 'WebSearch', // Research capabilities
          ],
        },
      })) {
        // Log scanner activity
        if (message.type === 'assistant' && 'message' in message) {
          const apiMessage = message.message as any;

          if (apiMessage.content && Array.isArray(apiMessage.content)) {
            for (const block of apiMessage.content) {
              if (block.type === 'text' && block.text) {
                console.log(`[SCAN] 💭 ${block.text.slice(0, 150)}${block.text.length > 150 ? '...' : ''}`);
              }
              if (block.type === 'thinking' && block.thinking) {
                console.log(`[SCAN] 🤔 ${block.thinking.slice(0, 150)}${block.thinking.length > 150 ? '...' : ''}`);
              }
              if (block.type === 'tool_use' && block.name) {
                console.log(`[SCAN] 🔧 Using: ${block.name}`);
              }
            }
          }
        }
      }

      console.log('[SCAN] Planning complete');
    } catch (error) {
      console.error('[SCAN] Error during planning:', error);
    }

    this.autonomousScanner.markScanned();
  }

  /**
   * Execute a single task
   */
  private async executeTask(task: Task): Promise<void> {
    const isResuming = task.status === 'in_progress';

    if (isResuming) {
      console.log(colors.inProgress(`\n${statusSymbols.inProgress} Resuming task: ${colors.bold(task.title)}`));
    } else {
      console.log(colors.inProgress(`\n${statusSymbols.inProgress} Executing task: ${colors.bold(task.title)}`));
      this.taskQueue.updateTaskStatus(task.id, 'in_progress');
    }

    this.supervisionHook.setCurrentTask(task.id);
    this.state.currentTaskId = task.id;

    // Status bar updates (streaming, non-intrusive)
    const taskStartTime = Date.now();
    let latestAction = '';

    // Track tool execution times and tool names
    const toolStartTimes = new Map<string, number>();
    const toolNames = new Map<string, string>();

    const updateStatusBar = () => {
      const elapsed = Math.floor((Date.now() - taskStartTime) / 1000);
      const statusText = formatTaskStatus({
        taskTitle: task.title,
        elapsedSeconds: elapsed,
        latestAction,
      });
      this.statusBar.update(statusText);
    };

    // Update status bar continuously (throttled internally to prevent flicker)
    const statusInterval = setInterval(updateStatusBar, 500);

    try {
      const systemPrompt = buildSystemPrompt({
        contextStore: this.contextStore,
        goalManager: this.goalManager,
        taskQueue: this.taskQueue,
        approvalQueue: this.approvalQueue,
      });

      // Build enriched task context with parent goal, responsibility, and sibling tasks
      let parentGoal: { title: string; description: string; progress: number } | undefined;
      let parentResponsibility: { name: string; description: string; domain: string } | undefined;
      let siblingTasks: Array<{ title: string; status: string; result?: string }> = [];

      // Get parent goal if task is linked to one
      if (task.parentGoalId) {
        const goal = this.goalManager.getGoal(task.parentGoalId);
        if (goal) {
          parentGoal = {
            title: goal.title,
            description: goal.description,
            progress: goal.progress,
          };
          // Get sibling tasks (other tasks in the same goal)
          siblingTasks = this.taskQueue.getTasksByGoal(task.parentGoalId)
            .filter((t) => t.id !== task.id) // Exclude current task
            .map((t) => ({
              title: t.title,
              status: t.status,
              result: t.result,
            }));
        }
      }

      // Get parent responsibility if task is linked to one
      if (task.context?.responsibilityId) {
        const resp = this.responsibilityManager.getAll()
          .find((r) => r.id === task.context.responsibilityId);
        if (resp) {
          parentResponsibility = {
            name: resp.name,
            description: resp.description,
            domain: resp.domain,
          };
          // If no parent goal, get sibling tasks from responsibility
          if (!parentGoal) {
            siblingTasks = this.taskQueue.getAllTasks()
              .filter((t) => t.context?.responsibilityId === resp.id && t.id !== task.id)
              .map((t) => ({
                title: t.title,
                status: t.status,
                result: t.result,
              }));
          }
        }
      }

      const taskPrompt = buildTaskPrompt({
        task,
        parentGoal,
        parentResponsibility,
        siblingTasks,
      });

      let result = '';

      for await (const message of query({
        prompt: taskPrompt,
        options: {
          systemPrompt,
          cwd: this.config.workingDirectory,
          model: this.config.model,
          mcpServers: {
            "playwright": {
              command: "npx",
              args: ["-y", "@playwright/mcp@latest"]
            },
            "deputy-tools": this.createDeputyTools()
          },
          allowedTools: [
            // Web research and delegation
            'WebFetch', 'WebSearch', 'Task',
            // Browser automation via Playwright MCP (supports canvas-based apps like Google Docs)
            'mcp__playwright__*', // Wildcard: allow all Playwright MCP tools
            // Deputy custom tools (goals, tasks, approvals, context, responsibilities)
            'mcp__deputy-tools__*', // Wildcard: allow all deputy learning tools
            // NOTE: All filesystem tools removed (Read/Write/Edit/Grep/Glob/Bash) - executive assistant works in browser only
          ],
          agents: getAgentDefinitions(),
          resume: this.currentSessionId,
          hooks: {
            PreToolUse: [{ hooks: [this.auditLog.createPreToolUseHook(task.id)] }],
            PostToolUse: [{ hooks: [this.auditLog.createPostToolUseHook(task.id)] }],
          },
        },
      })) {
        // Capture session ID for resumption
        if (message.type === 'system' && message.subtype === 'init') {
          this.currentSessionId = message.session_id;
          this.state.sessionId = message.session_id;
          this.saveState();
          this.taskQueue.addTaskLog(task.id, {
            type: 'info',
            message: isResuming ? 'Resuming task from previous session' : 'Task execution started'
          });
        }

        // Handle assistant messages (SDK format: message.message contains the actual API message)
        if (message.type === 'assistant' && 'message' in message) {
          const apiMessage = message.message as any;

          // Process content blocks in the API message
          if (apiMessage.content && Array.isArray(apiMessage.content)) {
            for (const block of apiMessage.content) {
              // Text content
              if (block.type === 'text' && block.text) {
                const textContent = block.text;
                if (textContent.trim()) {
                  latestAction = `💭 ${textContent.slice(0, 50)}${textContent.length > 50 ? '...' : ''}`;
                  this.taskQueue.addTaskLog(task.id, {
                    type: 'info',
                    message: `Agent: ${textContent.slice(0, 200)}`
                  });
                }
              }

              // Thinking blocks
              if (block.type === 'thinking' && block.thinking) {
                const thinking = block.thinking;
                if (thinking.trim()) {
                  latestAction = `🤔 ${thinking.slice(0, 50)}${thinking.length > 50 ? '...' : ''}`;
                  this.taskQueue.addTaskLog(task.id, {
                    type: 'thinking',
                    message: thinking.slice(0, 200)
                  });
                }
              }

              // Tool use
              if (block.type === 'tool_use' && block.name) {
                const toolName = block.name;
                const toolUseId = block.id;

                // Track tool start time and name
                if (toolUseId) {
                  toolStartTimes.set(toolUseId, Date.now());
                  toolNames.set(toolUseId, toolName);
                }

                // Shorten MCP tool names for display
                const displayName = toolName.startsWith('mcp__')
                  ? toolName.replace('mcp__chrome-devtools__', 'chrome:').replace('mcp__deputy-tools__', '')
                  : toolName;
                latestAction = `🔧 ${displayName}`;

                // Enhanced logging for Task tool (subagents)
                let logMessage = `Using tool: \`${toolName}\``;
                if (toolName === 'Task' && block.input) {
                  const input = block.input as any;
                  const subagentType = input.subagent_type || 'unknown';
                  const description = input.description || '';
                  const promptPreview = input.prompt ? input.prompt.slice(0, 100) : '';
                  logMessage = `Spawning subagent: **${subagentType}** - ${description || promptPreview}`;
                }

                this.taskQueue.addTaskLog(task.id, {
                  type: 'tool_use',
                  message: logMessage,
                  details: block.input
                });
              }
            }
          }
        }

        // Handle user messages (SDK format: message.message contains the actual API message)
        if (message.type === 'user' && 'message' in message) {
          const apiMessage = message.message as any;
          if (apiMessage.content && Array.isArray(apiMessage.content)) {
            for (const block of apiMessage.content) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                const isError = block.is_error || false;
                const toolUseId = block.tool_use_id;
                const wasTaskTool = toolNames.get(toolUseId) === 'Task';

                // Calculate tool duration if we tracked the start time
                let durationMsg = '';
                if (toolStartTimes.has(toolUseId)) {
                  const startTime = toolStartTimes.get(toolUseId)!;
                  const duration = Math.round((Date.now() - startTime) / 1000);
                  durationMsg = duration > 3 ? ` (${duration}s)` : '';
                  toolStartTimes.delete(toolUseId);
                }

                // For Task tool results, extract subagent activity summary
                if (wasTaskTool && !isError && block.content) {
                  const subagentSummary = this.extractSubagentSummary(block.content);
                  if (subagentSummary.length > 0) {
                    this.taskQueue.addTaskLog(task.id, {
                      type: 'info',
                      message: `**Subagent activity:**\n${subagentSummary.join('\n')}`
                    });
                  }
                }

                if (isError) {
                  this.taskQueue.addTaskLog(task.id, {
                    type: 'error',
                    message: `Tool failed${durationMsg}`
                  });
                } else if (durationMsg) {
                  // Only log successful completions if they took >3 seconds
                  this.taskQueue.addTaskLog(task.id, {
                    type: 'info',
                    message: `Tool completed${durationMsg}`
                  });
                }

                // Clean up tool name tracking
                toolNames.delete(toolUseId);
              }
            }
          }
        }

        // Capture result
        if ('result' in message && message.result) {
          result = message.result;
          this.taskQueue.addTaskLog(task.id, {
            type: 'info',
            message: 'Task completed with result'
          });
        }
      }

      // Clear periodic status interval and status bar
      if (statusInterval) {
        clearInterval(statusInterval);
      }
      this.statusBar.clear();

      // Task completed successfully
      this.taskQueue.updateTaskStatus(task.id, 'completed', result);
      console.log(colors.success(`${statusSymbols.success} Task completed: ${colors.bold(task.title)}\n`));

      // Propagate findings to parent Goal/Responsibility and Context Store
      await this.propagateTaskFindings(task);

      // Update goal progress if applicable
      if (task.parentGoalId) {
        const goalTasks = this.taskQueue.getTasksByGoal(task.parentGoalId);
        const completed = goalTasks.filter((t) => t.status === 'completed').length;
        this.goalManager.updateProgress(task.parentGoalId, completed, goalTasks.length);
      }
    } catch (error) {
      // Clear periodic status interval and status bar
      if (statusInterval) {
        clearInterval(statusInterval);
      }
      this.statusBar.clear();

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it's an approval block
      if (errorMessage.includes('Pending approval')) {
        console.log(colors.warning(`${statusSymbols.warning} Task waiting for approval: ${colors.bold(task.title)}`));
        // Task is already marked as waiting_approval by the hook
      } else if (errorMessage.toLowerCase().includes('tool') && (errorMessage.includes('not found') || errorMessage.includes('not allowed'))) {
        // Tool availability error - likely trying to use removed tools
        this.taskQueue.updateTaskStatus(task.id, 'failed', undefined, `Tool error: ${errorMessage}`);
        console.error(colors.error(`${statusSymbols.failed} Task failed (tool unavailable): ${colors.bold(task.title)}`));
        console.log(colors.dim(`   ${errorMessage.slice(0, 200)}`));
        console.log(colors.info(`   Tip: Task will restart with fresh session on next Deputy start\n`));
      } else {
        this.taskQueue.updateTaskStatus(task.id, 'failed', undefined, errorMessage);
        console.error(colors.error(`${statusSymbols.failed} Task failed: ${colors.bold(task.title)}`), error);
      }
    }

    this.state.currentTaskId = undefined;
    this.supervisionHook.setCurrentTask(undefined);
  }

  /**
   * Handle user chat message
   */
  async chat(userMessage: string): Promise<string> {
    const parsed = this.chatHandler.parseCommand(userMessage);

    if (parsed.type === 'command') {
      return this.handleCommand(parsed.command!, parsed.args);
    }

    // Regular chat - add to history and process
    this.chatHandler.addUserMessage(userMessage);

    const systemPrompt = buildSystemPrompt({
      contextStore: this.contextStore,
      goalManager: this.goalManager,
      taskQueue: this.taskQueue,
      approvalQueue: this.approvalQueue,
    });

    const chatContext = this.chatHandler.buildChatContext();
    const prompt = chatContext
      ? `Recent conversation:\n${chatContext}\n\nUser says: ${userMessage}`
      : userMessage;

    let response = '';

    for await (const message of query({
      prompt,
      options: {
        systemPrompt,
        cwd: this.config.workingDirectory,
        model: this.config.model,
        mcpServers: {
          "playwright": {
            command: "npx",
            args: ["-y", "@playwright/mcp@latest"]
          },
          "deputy-tools": this.createDeputyTools()
        },
        allowedTools: [
          'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
          'mcp__playwright__*', // Wildcard: allow all Playwright MCP tools
          'mcp__deputy-tools__*',    // Wildcard: allow all deputy custom tools
        ],
        resume: this.currentSessionId,
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        this.currentSessionId = message.session_id;
        this.state.sessionId = message.session_id;
        this.saveState();
      }
      if ('result' in message && message.result) {
        response = message.result;
      }
    }

    this.chatHandler.addDeputyMessage(response);
    return response;
  }

  /**
   * Handle slash commands
   */
  private handleCommand(command: string, args?: string): string {
    switch (command) {
      case 'status':
        return this.getStatusReport();

      case 'tasks': {
        if (!args || args === 'list') {
          return this.getTasksReport();
        }

        const [subcommand, ...subArgs] = args.split(' ');

        switch (subcommand) {
          case 'add': {
            if (subArgs.length === 0) {
              return colors.error('Usage: /tasks add <title> - <description>');
            }
            const fullArgs = subArgs.join(' ');
            const [title, ...descParts] = fullArgs.split(' - ');
            const description = descParts.join(' - ') || title;
            const result = this.createTaskFromParams({ title, description });
            return colors.success(`✓ Created task: ${result.title} (${result.id.slice(0, 8)})`);
          }

          case 'show': {
            if (subArgs.length === 0) {
              return colors.error('Usage: /tasks show <id>');
            }

            const identifier = subArgs.join(' ');
            const tasks = this.taskQueue.getAllTasks();
            const match = tasks.find((t) => t.id.startsWith(identifier));

            if (!match) {
              return colors.error(`Task not found: ${identifier}`);
            }

            const contextStr = Object.keys(match.context ?? {}).length > 0
              ? '\n**Context**: ' + JSON.stringify(match.context, null, 2)
              : '';

            // Format execution logs
            const logsStr = match.logs && match.logs.length > 0
              ? '\n\n## Execution Log\n\n' + match.logs.slice(-20).map((log) => {
                const timestamp = new Date(log.timestamp).toLocaleTimeString();
                const icon = log.type === 'tool_use' ? '🔧' : log.type === 'error' ? '❌' : log.type === 'thinking' ? '💭' : 'ℹ️';
                return `${icon} \`${timestamp}\` ${log.message}`;
              }).join('\n')
              : '';

            return renderMarkdown(
              `# Task Details\n\n` +
                `**Title**: ${match.title}\n` +
                `**Description**: ${match.description}\n` +
                `**Status**: ${match.status}\n` +
                `**Priority**: ${match.priority}\n` +
                `**Created**: ${match.createdAt.toISOString()}\n` +
                `**Updated**: ${match.updatedAt.toISOString()}\n` +
                `**Due**: ${match.dueDate?.toISOString() ?? 'none'}\n` +
                `**Result**: ${match.result ?? 'none'}\n` +
                `**Error**: ${match.error ?? 'none'}\n` +
                `**Tags**: ${match.tags?.join(', ') ?? 'none'}${contextStr}${logsStr}\n` +
                `**ID**: \`${match.id}\``
            );
          }

          case 'delete': {
            if (subArgs.length === 0) {
              return colors.error('Usage: /tasks delete <id>');
            }

            const identifier = subArgs.join(' ');
            const tasks = this.taskQueue.getAllTasks();
            const match = tasks.find((t) => t.id.startsWith(identifier));

            if (!match) {
              return colors.error(`Task not found: ${identifier}`);
            }

            this.taskQueue.deleteTask(match.id);
            return colors.success(`✓ Deleted task: ${match.title}`);
          }

          default:
            return colors.error(`Unknown tasks subcommand: ${subcommand}\nUse: list, add, show, delete`);
        }
      }

      case 'approvals':
        return this.getApprovalsReport();

      case 'approve': {
        if (!args) return 'Usage: /approve <approval-id>';
        try {
          const approval = this.approvalQueue.findApproval(args.trim());
          if (approval) {
            this.approvalQueue.approve(approval.id);
            this.taskQueue.approveTask(approval.taskId);
            return colors.success(`✓ Approved: ${approval.title}`);
          }
          return colors.error('Approval not found');
        } catch (error) {
          return colors.error(error instanceof Error ? error.message : 'Approval failed');
        }
      }

      case 'reject': {
        if (!args) return 'Usage: /reject <approval-id> <reason>';
        const [id, ...reasonParts] = args.split(' ');
        const reason = reasonParts.join(' ') || 'Rejected by user';

        try {
          const approval = this.approvalQueue.findApproval(id.trim());
          if (approval) {
            this.approvalQueue.reject(approval.id, reason);
            this.taskQueue.updateTaskStatus(approval.taskId, 'cancelled');
            return colors.warning(`✗ Rejected: ${approval.title}\nReason: ${reason}`);
          }
          return colors.error('Approval not found');
        } catch (error) {
          return colors.error(error instanceof Error ? error.message : 'Rejection failed');
        }
      }

      case 'goals': {
        if (!args || args === 'list') {
          const goals = this.goalManager.getActiveGoals();
          if (goals.length === 0) return colors.dim('No active goals.');

          const items = goals
            .map(
              (g) =>
                `- **${g.title}** *(${g.priority})* - ${g.progress}% complete - ${g.taskIds.length} task(s)\n  ${g.description} \`${g.id.slice(0, 8)}\``
            )
            .join('\n\n');

          return renderMarkdown(`# Goals\n\n${items}`);
        }

        const [subcommand, ...subArgs] = args.split(' ');

        switch (subcommand) {
          case 'add': {
            if (subArgs.length === 0) {
              return colors.error('Usage: /goals add <title> - <description>');
            }
            const fullArgs = subArgs.join(' ');
            const [title, ...descParts] = fullArgs.split(' - ');
            const description = descParts.join(' - ') || title;
            const result = this.createGoalFromParams({ title, description });
            return colors.success(`✓ Created goal: ${result.title} (${result.id.slice(0, 8)})`);
          }

          case 'show': {
            if (subArgs.length === 0) {
              return colors.error('Usage: /goals show <id>');
            }

            const identifier = subArgs.join(' ');
            const goals = this.goalManager.getAllGoals();
            const match = goals.find((g) => g.id.startsWith(identifier));

            if (!match) {
              return colors.error(`Goal not found: ${identifier}`);
            }

            const contextStr = Object.keys(match.context ?? {}).length > 0
              ? '\n**Context**: ' + JSON.stringify(match.context, null, 2)
              : '';

            // Get related tasks
            const relatedTasks = this.taskQueue.getAllTasks().filter(
              t => match.taskIds.includes(t.id)
            );
            const tasksStr = relatedTasks.length > 0
              ? '\n\n**Related Tasks** (' + relatedTasks.length + '):\n' +
                relatedTasks.map(t =>
                  `- [${t.status}] ${t.title} (\`${t.id.slice(0, 8)}\`)`
                ).join('\n')
              : '';

            // Find related responsibilities (responsibilities that have tasks in this goal)
            const relatedResponsibilities = this.responsibilityManager.getAll().filter(r => {
              const respTasks = this.taskQueue.getAllTasks().filter(
                t => t.context?.responsibilityId === r.id
              );
              return respTasks.some(t => match.taskIds.includes(t.id));
            });
            const responsibilitiesStr = relatedResponsibilities.length > 0
              ? '\n\n**Related Responsibilities** (' + relatedResponsibilities.length + '):\n' +
                relatedResponsibilities.map(r =>
                  `- [${r.status}] ${r.name} (\`${r.id.slice(0, 8)}\`)`
                ).join('\n')
              : '';

            return renderMarkdown(
              `# Goal Details\n\n` +
                `**Title**: ${match.title}\n` +
                `**Description**: ${match.description}\n` +
                `**Status**: ${match.status}\n` +
                `**Priority**: ${match.priority}\n` +
                `**Progress**: ${match.progress}%\n` +
                `**Tasks**: ${match.taskIds.length} task(s)\n` +
                `**Created**: ${match.createdAt.toISOString()}\n` +
                `**Updated**: ${match.updatedAt.toISOString()}\n` +
                `**Tags**: ${match.tags?.join(', ') ?? 'none'}${contextStr}${tasksStr}${responsibilitiesStr}\n` +
                `**ID**: \`${match.id}\``
            );
          }

          case 'delete': {
            if (subArgs.length === 0) {
              return colors.error('Usage: /goals delete <id>');
            }

            const identifier = subArgs.join(' ');
            const goals = this.goalManager.getAllGoals();
            const match = goals.find((g) => g.id.startsWith(identifier));

            if (!match) {
              return colors.error(`Goal not found: ${identifier}`);
            }

            this.goalManager.deleteGoal(match.id);
            return colors.success(`✓ Deleted goal: ${match.title}`);
          }

          default:
            return colors.error(`Unknown goals subcommand: ${subcommand}\nUse: list, add, show, delete`);
        }
      }

      case 'context': {
        if (!args || args === 'list') {
          // Default to listing all context with full details
          const entries = this.contextStore.getAllEntries();
          if (entries.length === 0) {
            return colors.dim('No context entries.');
          }

          const byCategory = new Map<string, typeof entries>();
          for (const entry of entries) {
            if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
            byCategory.get(entry.category)!.push(entry);
          }

          const sections = Array.from(byCategory.entries()).map(([cat, items]) => {
            const itemList = items
              .map((e) => {
                const valueStr = typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
                return `- **${e.key}**\n  ${valueStr}\n  \`${e.id.slice(0, 8)}\` *(${Math.round(e.confidence * 100)}% confidence)*`;
              })
              .join('\n\n');
            return `## ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n\n${itemList}`;
          });

          return renderMarkdown(`# Context (Detailed)\n\n${sections.join('\n\n')}`);
        }

        const [subcommand, ...subArgs] = args.split(' ');

        switch (subcommand) {
          case 'add': {
            if (subArgs.length < 3) {
              return colors.error(
                'Usage: /context add <category> <key> <value>\nExample: /context add preference timezone "America/Los_Angeles"'
              );
            }

            const [category, key, ...valueParts] = subArgs;
            const value = valueParts.join(' ');

            if (
              !['person', 'project', 'company', 'process', 'decision', 'preference', 'knowledge'].includes(
                category
              )
            ) {
              return colors.error(
                'Invalid category. Must be: person, project, company, process, decision, preference, knowledge'
              );
            }

            const result = this.storeContextFromParams({
              category: category as any,
              key,
              value,
            });

            return colors.success(`✓ Added/updated context: ${result.key}`);
          }

          case 'delete': {
            if (subArgs.length === 0) {
              return colors.error('Usage: /context delete <id-or-key>');
            }

            const identifier = subArgs.join(' ');

            // Try by ID first (if it looks like a UUID prefix)
            if (identifier.length >= 8 && identifier.match(/^[a-f0-9-]+$/i)) {
              const entries = this.contextStore.getAllEntries();
              const match = entries.find((e) => e.id.startsWith(identifier));
              if (match) {
                this.contextStore.delete(match.id);
                return colors.success(`✓ Deleted: ${match.key}`);
              }
            }

            // Try by key across all categories
            const entries = this.contextStore.getAllEntries();
            const match = entries.find((e) => e.key === identifier);
            if (match) {
              this.contextStore.delete(match.id);
              return colors.success(`✓ Deleted: ${match.key}`);
            }

            return colors.error(`Context entry not found: ${identifier}`);
          }

          case 'show': {
            if (subArgs.length === 0) {
              return colors.error('Usage: /context show <id-or-key>');
            }

            const identifier = subArgs.join(' ');

            // Try by ID first
            if (identifier.length >= 8 && identifier.match(/^[a-f0-9-]+$/i)) {
              const entries = this.contextStore.getAllEntries();
              const match = entries.find((e) => e.id.startsWith(identifier));
              if (match) {
                return renderMarkdown(
                  `# Context Entry\n\n` +
                    `**Category**: ${match.category}\n` +
                    `**Key**: ${match.key}\n` +
                    `**Value**: ${typeof match.value === 'string' ? match.value : JSON.stringify(match.value, null, 2)}\n` +
                    `**Source**: ${match.source}\n` +
                    `**Confidence**: ${Math.round(match.confidence * 100)}%\n` +
                    `**Created**: ${match.createdAt.toISOString()}\n` +
                    `**Updated**: ${match.updatedAt.toISOString()}\n` +
                    `**Tags**: ${match.tags.join(', ') || 'none'}\n` +
                    `**ID**: \`${match.id}\``
                );
              }
            }

            // Try by key
            const entries = this.contextStore.getAllEntries();
            const match = entries.find((e) => e.key === identifier);
            if (match) {
              return renderMarkdown(
                `# Context Entry\n\n` +
                  `**Category**: ${match.category}\n` +
                  `**Key**: ${match.key}\n` +
                  `**Value**: ${typeof match.value === 'string' ? match.value : JSON.stringify(match.value, null, 2)}\n` +
                  `**Source**: ${match.source}\n` +
                  `**Confidence**: ${Math.round(match.confidence * 100)}%\n` +
                  `**Created**: ${match.createdAt.toISOString()}\n` +
                  `**Updated**: ${match.updatedAt.toISOString()}\n` +
                  `**Tags**: ${match.tags.join(', ') || 'none'}\n` +
                  `**ID**: \`${match.id}\``
              );
            }

            return colors.error(`Context entry not found: ${identifier}`);
          }

          default:
            return colors.error(`Unknown context subcommand: ${subcommand}\nUse /context for usage.`);
        }
      }

      case 'responsibilities': {
        if (!args || args === 'list') {
          return this.getResponsibilitiesReport();
        }

        const [subCmd, ...subArgs] = args.split(' ');

        switch (subCmd) {
          case 'add': {
            const parts = subArgs.join(' ').split(' | ');
            if (parts.length < 2) {
              return colors.error('Usage: /responsibilities add <name> | <domain> | <description>');
            }
            const [name, domain, ...descParts] = parts;
            const description = descParts.join(' | ') || name;
            const result = this.createResponsibilityFromParams({
              name: name.trim(),
              domain: domain.trim(),
              description: description.trim(),
            });
            return colors.success(`✓ Created responsibility: ${result.name} (${result.id.slice(0, 8)})`);
          }

          case 'phase': {
            const [id, ...phaseParts] = subArgs;
            const phase = phaseParts.join(' ');
            if (!id || !phase) return colors.error('Usage: /responsibilities phase <id> <phase>');
            const resp = this.findResponsibility(id);
            if (!resp) return colors.error('Responsibility not found');
            this.responsibilityManager.setPhase(resp.id, phase);
            return colors.success(`✓ Set phase to "${phase}" for ${resp.name}`);
          }

          case 'pause': {
            const resp = this.findResponsibility(subArgs[0]);
            if (!resp) return colors.error('Responsibility not found');
            this.responsibilityManager.pause(resp.id);
            return colors.success(`✓ Paused: ${resp.name}`);
          }

          case 'resume': {
            const resp = this.findResponsibility(subArgs[0]);
            if (!resp) return colors.error('Responsibility not found');
            this.responsibilityManager.resume(resp.id);
            return colors.success(`✓ Resumed: ${resp.name}`);
          }

          case 'show': {
            if (subArgs.length === 0) {
              return colors.error('Usage: /responsibilities show <id>');
            }

            const resp = this.findResponsibility(subArgs[0]);
            if (!resp) return colors.error('Responsibility not found');

            const cadencesStr = resp.cadences.length > 0
              ? '\n**Cadences**: ' + resp.cadences.map(c => c.name).join(', ')
              : '';

            const peopleStr = resp.people.length > 0
              ? '\n**People**: ' + resp.people.map(p => p.name).join(', ')
              : '';

            const channelsStr = Object.keys(resp.channels).length > 0
              ? '\n**Channels**: ' + JSON.stringify(resp.channels, null, 2)
              : '';

            // Find related tasks
            const relatedTasks = this.taskQueue.getAllTasks().filter(
              t => t.context?.responsibilityId === resp.id
            );
            const tasksStr = relatedTasks.length > 0
              ? '\n\n**Related Tasks** (' + relatedTasks.length + '):\n' +
                relatedTasks.slice(0, 10).map(t =>
                  `- [${t.status}] ${t.title} (\`${t.id.slice(0, 8)}\`)`
                ).join('\n') +
                (relatedTasks.length > 10 ? `\n- ...and ${relatedTasks.length - 10} more` : '')
              : '';

            // Find related goals (goals that have tasks linked to this responsibility)
            const relatedGoals = this.goalManager.getAllGoals().filter(g =>
              g.taskIds.some(taskId =>
                relatedTasks.some(t => t.id === taskId)
              )
            );
            const goalsStr = relatedGoals.length > 0
              ? '\n\n**Related Goals** (' + relatedGoals.length + '):\n' +
                relatedGoals.map(g =>
                  `- [${g.status}] ${g.title} (\`${g.id.slice(0, 8)}\`) - ${g.progress}%`
                ).join('\n')
              : '';

            return renderMarkdown(
              `# Responsibility Details\n\n` +
                `**Name**: ${resp.name}\n` +
                `**Description**: ${resp.description}\n` +
                `**Domain**: ${resp.domain}\n` +
                `**Status**: ${resp.status}\n` +
                `**Phase**: ${resp.phase ?? 'none'}\n` +
                `**Created**: ${resp.createdAt.toISOString()}\n` +
                `**Updated**: ${resp.updatedAt.toISOString()}\n` +
                `**Last Attended**: ${resp.lastAttendedAt?.toISOString() ?? 'never'}${cadencesStr}${peopleStr}${channelsStr}\n` +
                `**Context**: ${resp.context || 'none'}\n` +
                `**Recent Activity**: ${resp.recentActivity.length} event(s)\n` +
                `**ID**: \`${resp.id}\`${tasksStr}${goalsStr}`
            );
          }

          case 'delete': {
            if (subArgs.length === 0) {
              return colors.error('Usage: /responsibilities delete <id>');
            }

            const resp = this.findResponsibility(subArgs[0]);
            if (!resp) return colors.error('Responsibility not found');

            this.responsibilityManager.delete(resp.id);
            return colors.success(`✓ Deleted responsibility: ${resp.name}`);
          }

          default:
            return colors.error('Unknown responsibilities subcommand. Use: list, add, show, delete, phase, pause, resume');
        }
      }

      case 'scan':
        this.autonomousScanner.forceScan();
        return 'Autonomous scan will run on next idle cycle...';

      case 'help': {
        const markdown = `# Deputy Commands

## Monitoring
- \`/status\` - Overall status report
- \`/approvals\` - List pending approvals

## Approvals
- \`/approve <id>\` - Approve an action (use 8+ char ID prefix)
  - Example: \`/approve a1b2c3d4\`
- \`/reject <id> <reason>\` - Reject an action
  - Example: \`/reject a1b2c3d4 Too risky\`

## Tasks
- \`/tasks [list|add|show|delete]\` - Manage tasks
  - \`/tasks\` or \`/tasks list\` - List all tasks
  - \`/tasks add <title> - <description>\` - Create a task
  - \`/tasks show <id>\` - Show full task details (Tab shows options)
  - \`/tasks delete <id>\` - Delete a task (Tab shows options)

## Goals
- \`/goals [list|add|show|delete]\` - Manage goals
  - \`/goals\` or \`/goals list\` - List all goals
  - \`/goals add <title> - <description>\` - Create a goal
  - \`/goals show <id>\` - Show full goal details (Tab shows options)
  - \`/goals delete <id>\` - Delete a goal (Tab shows options)

## Context
- \`/context [list|add|show|delete]\` - Manage context entries
  - \`/context\` or \`/context list\` - List all with IDs & confidence
  - \`/context add <category> <key> <value>\` - Add/update context
  - \`/context show <id-or-key>\` - Show full details (Tab shows options)
  - \`/context delete <id-or-key>\` - Delete entry (Tab shows options)
  - Categories: person, project, company, process, decision, preference, knowledge

## Responsibilities
- \`/responsibilities [list|add|show|delete|phase|pause|resume]\` - Manage responsibilities
  - \`/responsibilities\` or \`/responsibilities list\` - List all
  - \`/responsibilities add <name> | <domain> | <description>\` - Add new
  - \`/responsibilities show <id>\` - Show full details (Tab shows options)
  - \`/responsibilities delete <id>\` - Delete (Tab shows options)
  - \`/responsibilities phase <id> <phase>\` - Change phase (Tab shows options)
  - \`/responsibilities pause <id>\` - Pause (Tab shows options)
  - \`/responsibilities resume <id>\` - Resume (Tab shows options)

## Other
- \`/scan\` - Force autonomous scan
- \`/help\` - Show this help message

---
**Tips:**
- Press **Tab** after command names to see subcommand options
- Press **↑** to quickly inspect current task details (when task is running)
- Status bar at bottom shows: Current Task | Time | Latest Action`;
        return renderMarkdown(markdown);
      }

      default:
        return `Unknown command: ${command}. Use /help for available commands.`;
    }
  }

  /**
   * Reusable method to create a goal (used by MCP tools, slash commands, and scanner)
   */
  private createGoalFromParams(params: {
    title: string;
    description: string;
    priority?: 'critical' | 'high' | 'medium' | 'low';
    tags?: string[];
  }): { id: string; title: string } {
    const goal = this.goalManager.createGoal({
      title: params.title,
      description: params.description,
      priority: params.priority ?? 'medium',
      tags: params.tags ?? [],
    });
    console.log(`🎯 Created goal: ${goal.title} (${goal.id.slice(0, 8)})`);
    return { id: goal.id, title: goal.title };
  }

  /**
   * Reusable method to create a responsibility (used by MCP tools, slash commands, and scanner)
   */
  private createResponsibilityFromParams(params: {
    name: string;
    domain: string;
    description: string;
    phase?: string;
    dailyCadence?: string;
    weeklyCadence?: string;
    monthlyCadence?: string;
  }): { id: string; name: string } {
    const resp = this.responsibilityManager.create({
      name: params.name,
      domain: params.domain,
      description: params.description,
      phase: params.phase,
    });

    // Add cadences if provided
    if (params.dailyCadence) {
      this.responsibilityManager.addCadence(resp.id, {
        name: params.dailyCadence,
        schedule: { type: 'daily' },
      });
    }
    if (params.weeklyCadence) {
      this.responsibilityManager.addCadence(resp.id, {
        name: params.weeklyCadence,
        schedule: { type: 'weekly', day: 1 }, // Default to Monday
      });
    }
    if (params.monthlyCadence) {
      this.responsibilityManager.addCadence(resp.id, {
        name: params.monthlyCadence,
        schedule: { type: 'monthly', dayOfMonth: 1 }, // Default to 1st of month
      });
    }

    console.log(`📋 Created responsibility: ${resp.name} (${resp.id.slice(0, 8)})`);
    return { id: resp.id, name: resp.name };
  }

  /**
   * Reusable method to create a task (used by MCP tools, slash commands, and scanner)
   */
  private createTaskFromParams(params: {
    title: string;
    description: string;
    priority?: 'critical' | 'high' | 'medium' | 'low';
    parentGoalId?: string;
    context?: Record<string, unknown>;
  }): { id: string; title: string } {
    const task = this.taskQueue.addTask({
      title: params.title,
      description: params.description,
      priority: params.priority ?? 'medium',
      parentGoalId: params.parentGoalId,
      context: params.context ?? {},
    });

    // Link to goal if applicable
    if (params.parentGoalId) {
      this.goalManager.addTaskToGoal(params.parentGoalId, task.id);
    }

    // Mark responsibility as attended if linked
    if (params.context?.responsibilityId) {
      const respId = params.context.responsibilityId as string;
      this.responsibilityManager.markAttended(respId);
      this.responsibilityManager.addActivity(respId, 'task_created', params.title, task.id);
    }

    console.log(`✅ Created task: ${task.title} (${task.id.slice(0, 8)})`);
    return { id: task.id, title: task.title };
  }

  /**
   * Reusable method to store context (used by MCP tools, slash commands, and scanner)
   */
  private storeContextFromParams(params: {
    category: 'person' | 'project' | 'company' | 'process' | 'decision' | 'preference' | 'knowledge';
    key: string;
    value: string;
    confidence?: number;
    tags?: string[];
  }): { key: string; category: string } {
    const entry = this.contextStore.upsert({
      category: params.category,
      key: params.key,
      value: params.value,
      source: 'user',
      confidence: params.confidence ?? 1.0,
      tags: params.tags ?? [],
    });
    console.log(`💾 Stored ${params.category}: ${params.key}`);
    return { key: entry.key, category: entry.category };
  }

  /**
   * Propagate task findings to parent Goal/Responsibility and Context Store
   */
  private async propagateTaskFindings(task: Task): Promise<void> {
    if (!task.result) return;

    // Update parent goal with findings
    if (task.parentGoalId) {
      const goal = this.goalManager.getGoal(task.parentGoalId);
      if (goal) {
        const taskKey = `task_${task.id.slice(0, 8)}_findings`;
        this.goalManager.updateGoal(task.parentGoalId, {
          context: {
            ...goal.context,
            [taskKey]: task.result,
          },
        });
      }
    }

    // Update parent responsibility with findings
    if (task.context?.responsibilityId) {
      const respId = task.context.responsibilityId as string;
      this.responsibilityManager.addContext(
        respId,
        `[Task: ${task.title}]\n${task.result.slice(0, 500)}${task.result.length > 500 ? '...' : ''}`
      );
      this.responsibilityManager.markAttended(respId);
      this.responsibilityManager.addActivity(respId, 'task_completed', task.title, task.id);
    }

    // Extract stakeholders from task context and store them
    if (task.context?.stakeholders) {
      const stakeholders = task.context.stakeholders as string;
      const names = stakeholders.split(',').map((n: string) => n.trim());
      for (const name of names) {
        if (name && name.length > 2) {
          this.contextStore.upsert({
            category: 'person',
            key: name,
            value: `Stakeholder for: ${task.title}`,
            source: `task:${task.id.slice(0, 8)}`,
            confidence: 0.7,
          });
        }
      }
    }

    // Store key findings from task context
    if (task.context?.key_findings) {
      this.contextStore.upsert({
        category: 'knowledge',
        key: `${task.title.toLowerCase().replace(/\s+/g, '_')}_findings`,
        value: task.context.key_findings,
        source: `task:${task.id.slice(0, 8)}`,
        confidence: 0.8,
      });
    }
  }

  /**
   * Find responsibility by ID prefix
   */
  private findResponsibility(idPrefix: string): Responsibility | undefined {
    if (!idPrefix) return undefined;
    const all = this.responsibilityManager.getAll();
    return all.find((r) => r.id.startsWith(idPrefix));
  }

  /**
   * Generate responsibilities report
   */
  private getResponsibilitiesReport(): string {
    const all = this.responsibilityManager.getAll();
    if (all.length === 0) return colors.dim('No responsibilities. Use /responsibility add to create one.');

    const byDomain: { [domain: string]: typeof all } = {};
    for (const r of all) {
      if (!byDomain[r.domain]) byDomain[r.domain] = [];
      byDomain[r.domain].push(r);
    }

    const sections = Object.entries(byDomain).map(([domain, responsibilities]) => {
      const items = responsibilities
        .map((r) => {
          const phase = r.phase ? ` *(${r.phase})*` : '';
          const status = r.status !== 'active' ? ` *(${r.status})*` : '';
          const cadences = r.cadences.length > 0 ? ` - ${r.cadences.length} cadence(s)` : '';
          return `- **${r.name}**${phase}${status}${cadences} \`${r.id.slice(0, 8)}\``;
        })
        .join('\n');

      return `## ${domain}\n\n${items}`;
    });

    return renderMarkdown(`# Responsibilities\n\n${sections.join('\n\n')}`);
  }

  /**
   * Generate status report
   */
  private getStatusReport(): string {
    const taskStats = this.taskQueue.getStats();
    const approvalStats = this.approvalQueue.getStats();
    const goalStats = this.goalManager.getStats();
    const respStats = this.responsibilityManager.getStats();
    const nextScan = this.autonomousScanner.getNextScanTime();
    const minsToScan = Math.max(0, Math.round((nextScan.getTime() - Date.now()) / 60000));

    const domainList =
      Object.entries(respStats.byDomain)
        .map(([domain, count]) => `- ${domain}: ${count}`)
        .join('\n') || 'None';

    const runningStatus = this.state.isRunning ? colors.success('Running') : 'Stopped';

    const currentTask = this.state.currentTaskId
      ? (() => {
          const task = this.taskQueue.getTask(this.state.currentTaskId);
          return task ? `**${task.title}**` : colors.id(this.state.currentTaskId.slice(0, 8));
        })()
      : 'None';

    const markdown = `# Deputy Status

**State**: ${runningStatus}
**Current Task**: ${currentTask}
**Next Scan**: ${minsToScan}m

## Responsibilities
- **Active**: ${respStats.active}
${domainList}

## Goals
- **Active**: ${goalStats.active}
- **Completed**: ${goalStats.completed}
- **Average Progress**: ${goalStats.averageProgress}%

## Tasks
- **Pending**: ${taskStats.pending}
- **In Progress**: ${taskStats.inProgress}
- **Waiting Approval**: ${colors.warning(taskStats.waitingApproval.toString())}
- **Completed**: ${colors.success(taskStats.completed.toString())}
- **Failed**: ${taskStats.failed > 0 ? colors.error(taskStats.failed.toString()) : '0'}

## Approvals
- **Pending**: ${approvalStats.pending}
  - High Risk: ${colors.highRisk(approvalStats.byRisk.high.toString())}
  - Medium Risk: ${colors.mediumRisk(approvalStats.byRisk.medium.toString())}
  - Low Risk: ${colors.lowRisk(approvalStats.byRisk.low.toString())}`;

    return renderMarkdown(markdown);
  }

  /**
   * Generate tasks report
   */
  private getTasksReport(): string {
    const tasks = this.taskQueue.getAllTasks();
    if (tasks.length === 0) return colors.dim('No tasks.');

    const tasksByStatus = {
      in_progress: tasks.filter((t) => t.status === 'in_progress'),
      waiting_approval: tasks.filter((t) => t.status === 'waiting_approval'),
      approved: tasks.filter((t) => t.status === 'approved'),
      pending: tasks.filter((t) => t.status === 'pending'),
      completed: tasks.filter((t) => t.status === 'completed'),
      failed: tasks.filter((t) => t.status === 'failed'),
      cancelled: tasks.filter((t) => t.status === 'cancelled'),
    };

    const sections = [];

    if (tasksByStatus.in_progress.length > 0) {
      sections.push(
        `## In Progress\n\n` +
          tasksByStatus.in_progress
            .map((t) => `- **${t.title}** \`${t.id.slice(0, 8)}\``)
            .join('\n')
      );
    }

    if (tasksByStatus.waiting_approval.length > 0) {
      sections.push(
        `## Waiting Approval\n\n` +
          tasksByStatus.waiting_approval
            .map((t) => `- **${t.title}** \`${t.id.slice(0, 8)}\``)
            .join('\n')
      );
    }

    if (tasksByStatus.approved.length > 0) {
      sections.push(
        `## Approved\n\n` +
          tasksByStatus.approved.map((t) => `- **${t.title}** \`${t.id.slice(0, 8)}\``).join('\n')
      );
    }

    if (tasksByStatus.pending.length > 0) {
      sections.push(
        `## Pending\n\n` +
          tasksByStatus.pending.map((t) => `- **${t.title}** \`${t.id.slice(0, 8)}\``).join('\n')
      );
    }

    if (tasksByStatus.completed.length > 0) {
      sections.push(
        `## Completed\n\n` +
          tasksByStatus.completed.map((t) => `- ${t.title} \`${t.id.slice(0, 8)}\``).join('\n')
      );
    }

    if (tasksByStatus.failed.length > 0) {
      sections.push(
        `## Failed\n\n` +
          tasksByStatus.failed.map((t) => `- ${t.title} \`${t.id.slice(0, 8)}\``).join('\n')
      );
    }

    return renderMarkdown(`# Tasks\n\n${sections.join('\n\n')}`);
  }

  /**
   * Generate approvals report
   */
  private getApprovalsReport(): string {
    const pending = this.approvalQueue.getPending();
    if (pending.length === 0) return colors.dim('No pending approvals.');

    const items = pending
      .map((a, idx) => {
        const shortId = a.id.slice(0, 8);
        const riskBadge =
          a.risk === 'high' ? colors.highRisk(`[HIGH]`) : a.risk === 'medium' ? colors.mediumRisk(`[MEDIUM]`) : colors.lowRisk(`[LOW]`);
        return `${idx + 1}. ${riskBadge} **${a.title}**
   - ID: \`${shortId}\`
   - Action: ${a.proposedAction}
   - Command: \`/approve ${shortId}\` or \`/reject ${shortId} <reason>\``;
      })
      .join('\n\n');

    return renderMarkdown(`# Pending Approvals\n\n${items}`);
  }

  /**
   * Update statistics
   */
  private updateStats(): void {
    const taskStats = this.taskQueue.getStats();
    const approvalStats = this.approvalQueue.getStats();
    const goalStats = this.goalManager.getStats();
    const respStats = this.responsibilityManager.getStats();

    this.state.stats = {
      tasksCompleted: taskStats.completed,
      tasksInProgress: taskStats.inProgress,
      pendingApprovals: approvalStats.pending,
      activeGoals: goalStats.active,
      activeResponsibilities: respStats.active,
    };
    this.state.lastActivity = new Date();
  }

  /**
   * Save state to disk
   */
  private saveState(): void {
    const data: PersistedData = {
      tasks: this.taskQueue.toJSON(),
      goals: this.goalManager.toJSON(),
      approvals: this.approvalQueue.toJSON(),
      context: this.contextStore.toJSON(),
      responsibilities: this.responsibilityManager.toJSON(),
      state: this.state,
      lastSaved: new Date().toISOString(),
    };

    this.persistence.save(data);
  }

  /**
   * Get components for external access
   */
  getTaskQueue(): TaskQueue {
    return this.taskQueue;
  }

  getApprovalQueue(): ApprovalQueue {
    return this.approvalQueue;
  }

  getGoalManager(): GoalManager {
    return this.goalManager;
  }

  getContextStore(): ContextStore {
    return this.contextStore;
  }

  getChatHandler(): ChatHandler {
    return this.chatHandler;
  }

  getResponsibilityManager(): ResponsibilityManager {
    return this.responsibilityManager;
  }

  getState(): DeputyState {
    return { ...this.state };
  }

  getCurrentTaskId(): string | undefined {
    return this.state.currentTaskId;
  }

  /**
   * Extract subagent activity summary from Task tool result
   */
  private extractSubagentSummary(content: any): string[] {
    const summary: string[] = [];

    try {
      // Task tool returns array of text blocks with the subagent's result
      if (typeof content === 'string') {
        // Simple string result - show a preview
        const preview = content.slice(0, 200);
        summary.push(`  → Result: ${preview}${content.length > 200 ? '...' : ''}`);
      } else if (Array.isArray(content)) {
        // Array of content blocks - extract text
        for (const item of content) {
          if (item.type === 'text' && item.text) {
            const preview = item.text.slice(0, 200);
            summary.push(`  → ${preview}${item.text.length > 200 ? '...' : ''}`);
          }
        }
      }
    } catch (error) {
      // If parsing fails, just skip the summary
    }

    // Limit to 3 lines to avoid spam
    return summary.slice(0, 3);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);
      this.loopAbortController?.signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /**
   * Create custom MCP server for Deputy's autonomous learning and memory tools
   */
  private createDeputyTools() {
    return createSdkMcpServer({
      name: "deputy-tools",
      version: "1.0.0",
      tools: [
        tool(
          "StoreContext",
          "Store context, learnings, preferences, or insights for future reference. Use this when you learn something new, discover a preference, or want to remember a pattern.",
          {
            category: z.enum(["knowledge", "process", "preference", "decision", "person", "project", "company"]).describe("Category of context being stored"),
            key: z.string().describe("Short identifier for this context (e.g., 'screenshot-validation-delay', 'user-prefers-summaries')"),
            value: z.string().describe("The actual context, learning, or insight to store"),
            confidence: z.number().optional().default(0.8).describe("Confidence level 0-1 (default 0.8)"),
            tags: z.array(z.string()).optional().describe("Optional tags for cross-cutting searches")
          },
          async (args) => {
            this.contextStore.upsert({
              category: args.category,
              key: args.key,
              value: args.value,
              source: "agent-learning",
              confidence: args.confidence ?? 0.8,
              tags: args.tags ?? []
            });
            console.log(`📝 Stored: ${args.key}`);
            return { content: [{ type: "text" as const, text: `Context stored successfully: ${args.key}` }] };
          }
        ),

        tool(
          "DeleteContext",
          "Delete incorrect or outdated context by key name. Use this when you discover context is wrong or no longer relevant.",
          {
            key: z.string().describe("The key of the context entry to delete (e.g., 'current_strategic_priorities_q1_2026')")
          },
          async (args) => {
            const entries = this.contextStore.getAllEntries();
            const match = entries.find((e) => e.key === args.key);

            if (match) {
              this.contextStore.delete(match.id);
              console.log(`🗑️  Deleted: ${match.key}`);
              return { content: [{ type: "text" as const, text: `Context deleted: ${match.key}` }] };
            }

            return { content: [{ type: "text" as const, text: `Context not found: ${args.key}` }] };
          }
        ),

        tool(
          "UpdateContext",
          "Update existing context with new information. Use this when correcting or refining previously stored context.",
          {
            key: z.string().describe("The key of the context entry to update"),
            value: z.string().optional().describe("New value for the context"),
            confidence: z.number().optional().describe("Updated confidence level 0-1"),
            tags: z.array(z.string()).optional().describe("Updated tags")
          },
          async (args) => {
            const entries = this.contextStore.getAllEntries();
            const match = entries.find((e) => e.key === args.key);

            if (match) {
              const updated = this.contextStore.update(match.id, {
                value: args.value,
                confidence: args.confidence,
                tags: args.tags
              });

              if (updated) {
                console.log(`✏️  Updated: ${args.key}`);
                return { content: [{ type: "text" as const, text: `Context updated: ${args.key}` }] };
              }
            }

            return { content: [{ type: "text" as const, text: `Context not found: ${args.key}` }] };
          }
        ),

        tool(
          "ListContext",
          "List all stored context, optionally filtered by category. Useful for reviewing what you know before making decisions.",
          {
            category: z.enum(["knowledge", "process", "preference", "decision", "person", "project", "company"]).optional().describe("Optional category filter")
          },
          async (args) => {
            const entries = args.category
              ? this.contextStore.getByCategory(args.category)
              : this.contextStore.getAllEntries();

            if (entries.length === 0) {
              return { content: [{ type: "text" as const, text: args.category ? `No ${args.category} context found` : "No context stored yet" }] };
            }

            const summary = entries
              .map((e) => `- [${e.category}] ${e.key}: ${typeof e.value === 'string' ? e.value : JSON.stringify(e.value)} (${Math.round(e.confidence * 100)}%)`)
              .join('\n');

            return { content: [{ type: "text" as const, text: `Knowledge entries (${entries.length}):\n${summary}` }] };
          }
        ),

        tool(
          "CreateGoal",
          "Create a new goal when user mentions work to be done or objectives to achieve",
          {
            title: z.string().describe("Goal title"),
            description: z.string().describe("Detailed description"),
            priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium").describe("Goal priority"),
            tags: z.array(z.string()).optional().describe("Optional tags")
          },
          async (args) => {
            const result = this.createGoalFromParams(args);
            return { content: [{ type: "text" as const, text: `Goal created: ${result.title}` }] };
          }
        ),

        tool(
          "CreateResponsibility",
          "Create an ongoing responsibility when user mentions recurring work or monitoring needs",
          {
            name: z.string().describe("Responsibility name"),
            domain: z.enum(["project", "executive", "recruiting", "operations", "custom"]).describe("Responsibility domain"),
            description: z.string().describe("What this responsibility involves"),
            phase: z.string().optional().describe("Current phase"),
            dailyCadence: z.string().optional().describe("Daily cadence description (e.g., 'Standup prep at 9am')"),
            weeklyCadence: z.string().optional().describe("Weekly cadence description"),
            monthlyCadence: z.string().optional().describe("Monthly cadence description")
          },
          async (args) => {
            const result = this.createResponsibilityFromParams(args);
            return { content: [{ type: "text" as const, text: `Responsibility created: ${result.name}` }] };
          }
        ),

        tool(
          "CreateTask",
          "Create a new task proactively when you identify work that needs to be done",
          {
            title: z.string().describe("Task title"),
            description: z.string().describe("Task description"),
            priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium").describe("Task priority"),
            parentGoalId: z.string().optional().describe("Parent goal ID if this is part of a goal"),
            context: z.record(z.string(), z.unknown()).optional().describe("Additional context for the task")
          },
          async (args) => {
            const result = this.createTaskFromParams(args);
            return { content: [{ type: "text" as const, text: `Task created: ${result.title}` }] };
          }
        ),

        tool(
          "UpdateGoal",
          "Update an existing goal's title, description, or priority",
          {
            goalId: z.string().describe("Goal ID to update"),
            title: z.string().optional().describe("New title"),
            description: z.string().optional().describe("New description"),
            priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("New priority")
          },
          async (args) => {
            const goal = this.goalManager.updateGoal(args.goalId, {
              title: args.title,
              description: args.description,
              priority: args.priority
            });
            if (goal) {
              console.log(`✏️  Updated goal: ${goal.title} (${goal.id.slice(0, 8)})`);
              return { content: [{ type: "text" as const, text: `Goal updated: ${goal.title}` }] };
            }
            return { content: [{ type: "text" as const, text: `Goal not found: ${args.goalId}` }] };
          }
        ),

        tool(
          "DeleteGoal",
          "Delete a goal when it becomes obsolete or was created in error",
          {
            goalId: z.string().describe("Goal ID to delete")
          },
          async (args) => {
            const goal = this.goalManager.getGoal(args.goalId);
            if (goal) {
              this.goalManager.deleteGoal(args.goalId);
              console.log(`🗑️  Deleted goal: ${goal.title} (${goal.id.slice(0, 8)})`);
              return { content: [{ type: "text" as const, text: `Goal deleted: ${goal.title}` }] };
            }
            return { content: [{ type: "text" as const, text: `Goal not found: ${args.goalId}` }] };
          }
        ),

        tool(
          "UpdateResponsibility",
          "Update an existing responsibility's name, description, domain, or phase",
          {
            responsibilityId: z.string().describe("Responsibility ID to update"),
            name: z.string().optional().describe("New name"),
            description: z.string().optional().describe("New description"),
            domain: z.string().optional().describe("New domain"),
            phase: z.string().optional().describe("New phase")
          },
          async (args) => {
            const resp = this.responsibilityManager.get(args.responsibilityId);
            if (resp) {
              if (args.name) this.responsibilityManager.update(args.responsibilityId, { name: args.name });
              if (args.description) this.responsibilityManager.update(args.responsibilityId, { description: args.description });
              if (args.domain) this.responsibilityManager.update(args.responsibilityId, { domain: args.domain });
              if (args.phase) this.responsibilityManager.setPhase(args.responsibilityId, args.phase);
              console.log(`✏️  Updated responsibility: ${resp.name} (${resp.id.slice(0, 8)})`);
              return { content: [{ type: "text" as const, text: `Responsibility updated: ${resp.name}` }] };
            }
            return { content: [{ type: "text" as const, text: `Responsibility not found: ${args.responsibilityId}` }] };
          }
        ),

        tool(
          "DeleteResponsibility",
          "Delete a responsibility when it's no longer needed",
          {
            responsibilityId: z.string().describe("Responsibility ID to delete")
          },
          async (args) => {
            const resp = this.responsibilityManager.get(args.responsibilityId);
            if (resp) {
              this.responsibilityManager.delete(args.responsibilityId);
              console.log(`🗑️  Deleted responsibility: ${resp.name} (${resp.id.slice(0, 8)})`);
              return { content: [{ type: "text" as const, text: `Responsibility deleted: ${resp.name}` }] };
            }
            return { content: [{ type: "text" as const, text: `Responsibility not found: ${args.responsibilityId}` }] };
          }
        ),

        tool(
          "UpdateTask",
          "Update an existing task's title, description, or priority",
          {
            taskId: z.string().describe("Task ID to update"),
            title: z.string().optional().describe("New title"),
            description: z.string().optional().describe("New description"),
            priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("New priority")
          },
          async (args) => {
            const task = this.taskQueue.getTask(args.taskId);
            if (task) {
              this.taskQueue.updateTask(args.taskId, {
                title: args.title,
                description: args.description,
                priority: args.priority
              });
              console.log(`✏️  Updated task: ${task.title} (${task.id.slice(0, 8)})`);
              return { content: [{ type: "text" as const, text: `Task updated: ${task.title}` }] };
            }
            return { content: [{ type: "text" as const, text: `Task not found: ${args.taskId}` }] };
          }
        ),

        tool(
          "DeleteTask",
          "Delete a task when it's no longer needed or was created in error",
          {
            taskId: z.string().describe("Task ID to delete")
          },
          async (args) => {
            const task = this.taskQueue.getTask(args.taskId);
            if (task) {
              this.taskQueue.deleteTask(args.taskId);
              console.log(`🗑️  Deleted task: ${task.title} (${task.id.slice(0, 8)})`);
              return { content: [{ type: "text" as const, text: `Task deleted: ${task.title}` }] };
            }
            return { content: [{ type: "text" as const, text: `Task not found: ${args.taskId}` }] };
          }
        ),

        tool(
          "UpdateTaskContext",
          "Add context or findings to the current task as you work on it",
          {
            contextUpdates: z.record(z.string(), z.unknown()).describe("Key-value pairs to add to task context"),
            note: z.string().optional().describe("Optional note about what you discovered")
          },
          async (args) => {
            const taskId = this.state.currentTaskId;
            if (!taskId) {
              return { content: [{ type: "text" as const, text: "No active task to update" }] };
            }

            const currentTask = this.taskQueue.getTask(taskId);
            if (!currentTask) {
              return { content: [{ type: "text" as const, text: "Task not found" }] };
            }

            const updatedContext = { ...currentTask.context, ...args.contextUpdates };

            if (args.note) {
              updatedContext._notes = [
                ...(updatedContext._notes as string[] || []),
                `${new Date().toISOString()}: ${args.note}`
              ];
            }

            this.taskQueue.updateTask(taskId, { context: updatedContext });

            return { content: [{ type: "text" as const, text: "Task context updated" }] };
          }
        ),

        tool(
          "RequestApproval",
          "Request user approval for a specific action. Use this when you need explicit approval before proceeding (e.g., sending messages, making changes). This creates an approval request that user can review via /approvals.",
          {
            title: z.string().describe("Brief title of what needs approval (e.g., 'Send CEO message about recruitment')"),
            description: z.string().describe("Detailed description of what you want to do and why"),
            proposedAction: z.string().describe("The specific action you'll take if approved (e.g., 'Send Slack message to Alexey with recruitment briefing')"),
            risk: z.enum(["low", "medium", "high"]).optional().default("medium").describe("Risk level of the action"),
            details: z.record(z.string(), z.unknown()).optional().describe("Additional details (message content, etc.)")
          },
          async (args) => {
            const approval = this.approvalQueue.requestApproval({
              taskId: this.state.currentTaskId ?? 'direct-request',
              type: 'action',
              title: args.title,
              description: args.description,
              proposedAction: args.proposedAction,
              risk: args.risk ?? 'medium',
              details: args.details ?? {}
            });

            // Update task status if there's an active task
            if (this.state.currentTaskId) {
              this.taskQueue.setTaskApproval(this.state.currentTaskId, approval.id);
            }

            console.log(`📋 Approval requested: ${args.title} (${approval.id.slice(0, 8)})`);

            return {
              content: [{
                type: "text" as const,
                text: `Approval request created: ${approval.id}\n\nUser can review and approve via /approvals command.\n\nWhen approved, proceed with: ${args.proposedAction}`
              }]
            };
          }
        )
      ]
    });
  }
}
