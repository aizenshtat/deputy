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
import { ResponsibilityManager } from '../memory/responsibilities.js';
import { Persistence, PersistedData } from '../memory/persistence.js';
import { AuditLog } from '../hooks/audit-log.js';
import { SupervisionHook } from '../hooks/supervision.js';
import { getAgentDefinitions } from '../agents/index.js';
import { buildSystemPrompt, buildTaskPrompt } from '../config/system-prompt.js';
import { DeputyState, DeputyConfig, Task } from '../types.js';

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

    // Initialize autonomous scanner
    this.autonomousScanner = new AutonomousScanner({
      responsibilityManager: this.responsibilityManager,
      taskQueue: this.taskQueue,
      contextStore: this.contextStore,
      goalManager: this.goalManager,
      scanIntervalMs: 30 * 60 * 1000, // 30 minutes
      model: this.config.model,
      cwd: this.config.workingDirectory,
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

      // Restore session ID for conversation continuity
      this.currentSessionId = data.state.sessionId;

      // Re-attach change listeners
      this.taskQueue.onChange(() => this.saveState());
      this.approvalQueue.onChange(() => this.saveState());
      this.contextStore.onChange(() => this.saveState());
      this.goalManager.onChange(() => this.saveState());
      this.responsibilityManager.onChange(() => this.saveState());

      // Re-create supervision hook with restored queues
      this.supervisionHook = new SupervisionHook(this.approvalQueue, this.taskQueue);

      // Re-create autonomous scanner with restored managers
      this.autonomousScanner = new AutonomousScanner({
        responsibilityManager: this.responsibilityManager,
        taskQueue: this.taskQueue,
        contextStore: this.contextStore,
        goalManager: this.goalManager,
        scanIntervalMs: 30 * 60 * 1000,
        model: this.config.model,
        cwd: this.config.workingDirectory,
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
   * Stop the agent
   */
  stop(): void {
    this.state.isRunning = false;
    this.loopAbortController?.abort();
    this.loopAbortController = null;
    console.log('Deputy stopped');
  }

  /**
   * Main execution loop
   */
  private async runLoop(): Promise<void> {
    let idleLogged = false;

    while (this.state.isRunning) {
      try {
        // Check for workable tasks
        const nextTask = this.taskQueue.getNextTask();

        if (nextTask) {
          idleLogged = false;
          await this.executeTask(nextTask);
        } else {
          // No tasks available, check for approved tasks
          const approvedTasks = this.taskQueue.getTasksByStatus('approved');
          if (approvedTasks.length > 0) {
            idleLogged = false;
            await this.executeTask(approvedTasks[0]);
          } else {
            // Idle - run autonomous scanner if it's time
            if (this.autonomousScanner.shouldScan()) {
              idleLogged = false;
              await this.autonomousScanner.scan();
            } else if (!idleLogged) {
              const stats = this.taskQueue.getStats();
              const approvals = this.approvalQueue.getStats();
              const respStats = this.responsibilityManager.getStats();
              const nextScan = this.autonomousScanner.getNextScanTime();
              const minsToScan = Math.round((nextScan.getTime() - Date.now()) / 60000);

              if (stats.waitingApproval > 0 || approvals.pending > 0) {
                console.log(`[IDLE] Waiting for ${approvals.pending} approval(s). Use /approvals to review.`);
              } else if (respStats.active > 0) {
                console.log(`[IDLE] Monitoring ${respStats.active} responsibility(ies). Next scan in ${minsToScan}m.`);
              } else {
                console.log('[IDLE] No tasks or responsibilities. Use /responsibility to add ongoing work.');
              }
              idleLogged = true;
            }
          }
        }

        // Update stats
        this.updateStats();

        // Wait before next iteration
        await this.sleep(this.config.pollingIntervalMs);
      } catch (error) {
        console.error('Error in main loop:', error);
        await this.sleep(this.config.pollingIntervalMs);
      }
    }
  }

  /**
   * Execute a single task
   */
  private async executeTask(task: Task): Promise<void> {
    console.log(`Executing task: ${task.title}`);

    this.taskQueue.updateTaskStatus(task.id, 'in_progress');
    this.supervisionHook.setCurrentTask(task.id);
    this.state.currentTaskId = task.id;

    try {
      const systemPrompt = buildSystemPrompt({
        contextStore: this.contextStore,
        goalManager: this.goalManager,
        taskQueue: this.taskQueue,
        approvalQueue: this.approvalQueue,
      });

      const taskPrompt = buildTaskPrompt(task);

      let result = '';

      for await (const message of query({
        prompt: taskPrompt,
        options: {
          systemPrompt,
          cwd: this.config.workingDirectory,
          model: this.config.model,
          mcpServers: {
            "chrome-devtools": {
              command: "npx",
              args: ["-y", "chrome-devtools-mcp@latest", "--browser-url=http://127.0.0.1:9222"]
            },
            "deputy-tools": this.createDeputyTools()
          },
          allowedTools: [
            'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task',
            'mcp__chrome-devtools__*', // Wildcard: allow all chrome-devtools MCP tools
            'mcp__deputy-tools__*', // Wildcard: allow all deputy learning tools
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
        }

        // Capture result
        if ('result' in message && message.result) {
          result = message.result;
        }
      }

      // Task completed successfully
      this.taskQueue.updateTaskStatus(task.id, 'completed', result);
      console.log(`Task completed: ${task.title}`);

      // Update goal progress if applicable
      if (task.parentGoalId) {
        const goalTasks = this.taskQueue.getTasksByGoal(task.parentGoalId);
        const completed = goalTasks.filter((t) => t.status === 'completed').length;
        this.goalManager.updateProgress(task.parentGoalId, completed, goalTasks.length);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it's an approval block
      if (errorMessage.includes('Pending approval')) {
        console.log(`Task waiting for approval: ${task.title}`);
        // Task is already marked as waiting_approval by the hook
      } else {
        this.taskQueue.updateTaskStatus(task.id, 'failed', undefined, errorMessage);
        console.error(`Task failed: ${task.title}`, error);
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
          "chrome-devtools": {
            command: "npx",
            args: ["-y", "chrome-devtools-mcp@latest", "--browser-url=http://127.0.0.1:9222"]
          },
          "deputy-tools": this.createDeputyTools()
        },
        allowedTools: [
          'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
          'mcp__chrome-devtools__*', // Wildcard: allow all chrome-devtools MCP tools
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

      case 'tasks':
        return this.getTasksReport();

      case 'approvals':
        return this.getApprovalsReport();

      case 'approve': {
        if (!args) return 'Usage: /approve <approval-id>';
        const approval = this.approvalQueue.approve(args);
        if (approval) {
          this.taskQueue.approveTask(approval.taskId);
          return `Approved: ${approval.title}`;
        }
        return 'Approval not found';
      }

      case 'reject': {
        if (!args) return 'Usage: /reject <approval-id> <reason>';
        const [id, ...reasonParts] = args.split(' ');
        const reason = reasonParts.join(' ') || 'Rejected by user';
        const rejection = this.approvalQueue.reject(id, reason);
        if (rejection) {
          this.taskQueue.updateTaskStatus(rejection.taskId, 'cancelled');
          return `Rejected: ${rejection.title}`;
        }
        return 'Approval not found';
      }

      case 'goal': {
        if (!args) return 'Usage: /goal <title> - <description>';
        const [title, ...descParts] = args.split(' - ');
        const description = descParts.join(' - ') || title;
        const goal = this.goalManager.createGoal({ title, description });
        return `Created goal: ${goal.title} (${goal.id})`;
      }

      case 'task': {
        if (!args) return 'Usage: /task <title> - <description>';
        const [title, ...descParts] = args.split(' - ');
        const description = descParts.join(' - ') || title;
        const task = this.taskQueue.addTask({ title, description });
        return `Created task: ${task.title} (${task.id})`;
      }

      case 'context': {
        return this.contextStore.buildContextSummary();
      }

      case 'responsibilities':
      case 'resp':
        return this.getResponsibilitiesReport();

      case 'responsibility': {
        if (!args) {
          return `Usage:
/responsibility add <name> | <domain> | <description>
/responsibility phase <id> <phase>
/responsibility pause <id>
/responsibility resume <id>
/responsibility scan - Force autonomous scan now`;
        }

        const [subCmd, ...subArgs] = args.split(' ');

        switch (subCmd) {
          case 'add': {
            const parts = subArgs.join(' ').split(' | ');
            if (parts.length < 2) {
              return 'Usage: /responsibility add <name> | <domain> | <description>';
            }
            const [name, domain, ...descParts] = parts;
            const description = descParts.join(' | ') || name;
            const resp = this.responsibilityManager.create({
              name: name.trim(),
              domain: domain.trim(),
              description: description.trim(),
            });
            return `Created responsibility: ${resp.name} (${resp.id.slice(0, 8)})`;
          }

          case 'phase': {
            const [id, ...phaseParts] = subArgs;
            const phase = phaseParts.join(' ');
            if (!id || !phase) return 'Usage: /responsibility phase <id> <phase>';
            const resp = this.findResponsibility(id);
            if (!resp) return 'Responsibility not found';
            this.responsibilityManager.setPhase(resp.id, phase);
            return `Set phase to "${phase}" for ${resp.name}`;
          }

          case 'pause': {
            const resp = this.findResponsibility(subArgs[0]);
            if (!resp) return 'Responsibility not found';
            this.responsibilityManager.pause(resp.id);
            return `Paused: ${resp.name}`;
          }

          case 'resume': {
            const resp = this.findResponsibility(subArgs[0]);
            if (!resp) return 'Responsibility not found';
            this.responsibilityManager.resume(resp.id);
            return `Resumed: ${resp.name}`;
          }

          case 'scan':
            this.autonomousScanner.forceScan().catch(console.error);
            return 'Forcing autonomous scan...';

          default:
            return `Unknown subcommand: ${subCmd}`;
        }
      }

      case 'scan':
        this.autonomousScanner.forceScan().catch(console.error);
        return 'Forcing autonomous scan...';

      case 'help':
        return `Available commands:
/status - Overall status report
/tasks - List all tasks
/approvals - List pending approvals
/approve <id> - Approve an action
/reject <id> <reason> - Reject an action
/goal <title> - <description> - Create a new goal
/task <title> - <description> - Create a new task
/responsibilities - List all responsibilities
/responsibility add <name> | <domain> | <description> - Add ongoing responsibility
/responsibility phase <id> <phase> - Change phase
/responsibility pause/resume <id> - Pause or resume
/scan - Force autonomous scan
/context - Show accumulated context
/help - Show this help`;

      default:
        return `Unknown command: ${command}. Use /help for available commands.`;
    }
  }

  /**
   * Find responsibility by ID prefix
   */
  private findResponsibility(idPrefix: string): { id: string; name: string } | undefined {
    if (!idPrefix) return undefined;
    const all = this.responsibilityManager.getAll();
    return all.find((r) => r.id.startsWith(idPrefix));
  }

  /**
   * Generate responsibilities report
   */
  private getResponsibilitiesReport(): string {
    const all = this.responsibilityManager.getAll();
    if (all.length === 0) return 'No responsibilities. Use /responsibility add to create one.';

    return all
      .map((r) => {
        const phase = r.phase ? ` [${r.phase}]` : '';
        const status = r.status !== 'active' ? ` (${r.status})` : '';
        const cadences = r.cadences.length > 0 ? ` - ${r.cadences.length} cadence(s)` : '';
        return `[${r.domain}] ${r.name}${phase}${status}${cadences}\n  ID: ${r.id.slice(0, 8)}`;
      })
      .join('\n\n');
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

    const domainList = Object.entries(respStats.byDomain)
      .map(([domain, count]) => `  - ${domain}: ${count}`)
      .join('\n') || '  None';

    return `# Deputy Status

**State**: ${this.state.isRunning ? 'Running' : 'Stopped'}
**Current Task**: ${this.state.currentTaskId ?? 'None'}
**Next Scan**: ${minsToScan}m

## Responsibilities
- Active: ${respStats.active}
${domainList}

## Goals
- Active: ${goalStats.active}
- Completed: ${goalStats.completed}
- Average Progress: ${goalStats.averageProgress}%

## Tasks
- Pending: ${taskStats.pending}
- In Progress: ${taskStats.inProgress}
- Waiting Approval: ${taskStats.waitingApproval}
- Completed: ${taskStats.completed}
- Failed: ${taskStats.failed}

## Approvals
- Pending: ${approvalStats.pending}
  - High Risk: ${approvalStats.byRisk.high}
  - Medium Risk: ${approvalStats.byRisk.medium}
  - Low Risk: ${approvalStats.byRisk.low}`;
  }

  /**
   * Generate tasks report
   */
  private getTasksReport(): string {
    const tasks = this.taskQueue.getAllTasks();
    if (tasks.length === 0) return 'No tasks.';

    return tasks
      .map((t) => `[${t.status}] ${t.title} (${t.id.slice(0, 8)})`)
      .join('\n');
  }

  /**
   * Generate approvals report
   */
  private getApprovalsReport(): string {
    const pending = this.approvalQueue.getPending();
    if (pending.length === 0) return 'No pending approvals.';

    return pending
      .map((a) => `[${a.risk}] ${a.title}\n  ID: ${a.id}\n  Action: ${a.proposedAction}`)
      .join('\n\n');
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
          "StoreKnowledge",
          "Store knowledge, learnings, preferences, or insights for future reference. Use this when you learn something new, discover a preference, or want to remember a pattern.",
          {
            category: z.enum(["knowledge", "process", "preference", "decision", "person", "project", "company"]).describe("Category of knowledge being stored"),
            key: z.string().describe("Short identifier for this knowledge (e.g., 'screenshot-validation-delay', 'user-prefers-summaries')"),
            value: z.string().describe("The actual knowledge, learning, or insight to store"),
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
            return { content: [{ type: "text" as const, text: `Knowledge stored successfully: ${args.key}` }] };
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
            const goal = this.goalManager.createGoal({
              title: args.title,
              description: args.description,
              priority: args.priority ?? "medium",
              tags: args.tags ?? []
            });
            console.log(`🎯 Created goal: ${goal.title} (${goal.id.slice(0, 8)})`);
            return { content: [{ type: "text" as const, text: `Goal created: ${goal.title}` }] };
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
            const resp = this.responsibilityManager.create({
              name: args.name,
              domain: args.domain,
              description: args.description,
              phase: args.phase
            });

            // Add cadences if provided
            if (args.dailyCadence) {
              this.responsibilityManager.addCadence(resp.id, {
                name: args.dailyCadence,
                schedule: { type: 'daily' }
              });
            }
            if (args.weeklyCadence) {
              this.responsibilityManager.addCadence(resp.id, {
                name: args.weeklyCadence,
                schedule: { type: 'weekly', day: 1 } // Default to Monday
              });
            }
            if (args.monthlyCadence) {
              this.responsibilityManager.addCadence(resp.id, {
                name: args.monthlyCadence,
                schedule: { type: 'monthly', dayOfMonth: 1 } // Default to 1st of month
              });
            }

            console.log(`📋 Created responsibility: ${resp.name} (${resp.id.slice(0, 8)})`);
            return { content: [{ type: "text" as const, text: `Responsibility created: ${resp.name}` }] };
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
            const task = this.taskQueue.addTask({
              title: args.title,
              description: args.description,
              priority: args.priority ?? "medium",
              parentGoalId: args.parentGoalId,
              context: args.context ?? {}
            });
            console.log(`✅ Created task: ${task.title} (${task.id.slice(0, 8)})`);
            return { content: [{ type: "text" as const, text: `Task created: ${task.title}` }] };
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
        )
      ]
    });
  }
}
