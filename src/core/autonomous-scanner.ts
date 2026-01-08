/**
 * Autonomous Scanner - Proactively identifies work that needs to be done
 *
 * Runs when the agent is idle and:
 * 1. Checks for due cadences (daily standups, weekly preps, etc.)
 * 2. Reviews responsibilities needing attention
 * 3. Uses LLM to determine what tasks should be created
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ResponsibilityManager, Responsibility, Cadence } from '../memory/responsibilities.js';
import { TaskQueue } from './task-queue.js';
import { ContextStore } from '../memory/context-store.js';
import { GoalManager } from '../memory/goals.js';

export interface ScanResult {
  scannedAt: Date;
  dueCadences: Array<{ responsibility: Responsibility; cadence: Cadence }>;
  needingAttention: Responsibility[];
  tasksCreated: number;
  nextScanAt: Date;
}

export interface CreationCallbacks {
  createGoal: (params: { title: string; description: string; priority?: 'critical' | 'high' | 'medium' | 'low' }) => { id: string; title: string };
  createResponsibility: (params: { name: string; domain: string; description: string }) => { id: string; name: string };
  createTask: (params: { title: string; description: string; priority?: 'critical' | 'high' | 'medium' | 'low'; parentGoalId?: string; context?: Record<string, unknown> }) => { id: string; title: string };
  storeContext: (params: { category: 'person' | 'project' | 'company' | 'process' | 'decision' | 'preference' | 'knowledge'; key: string; value: string }) => { key: string; category: string };
}

export class AutonomousScanner {
  private responsibilityManager: ResponsibilityManager;
  private taskQueue: TaskQueue;
  private contextStore: ContextStore;
  private goalManager: GoalManager;
  private creationCallbacks: CreationCallbacks;
  private mcpServerFactory: () => any;

  private lastScanAt: Date | null = null;
  private scanIntervalMs: number;
  private model?: string;
  private cwd: string;
  private startedAt: Date;

  constructor(params: {
    responsibilityManager: ResponsibilityManager;
    taskQueue: TaskQueue;
    contextStore: ContextStore;
    goalManager: GoalManager;
    creationCallbacks: CreationCallbacks;
    mcpServerFactory: () => any;
    scanIntervalMs?: number;
    model?: string;
    cwd?: string;
  }) {
    this.responsibilityManager = params.responsibilityManager;
    this.taskQueue = params.taskQueue;
    this.contextStore = params.contextStore;
    this.goalManager = params.goalManager;
    this.creationCallbacks = params.creationCallbacks;
    this.mcpServerFactory = params.mcpServerFactory;
    this.scanIntervalMs = params.scanIntervalMs ?? 30 * 60 * 1000; // 30 min default
    this.model = params.model;
    this.cwd = params.cwd ?? process.cwd();
    this.startedAt = new Date();
  }

  /**
   * Check if it's time to scan
   */
  shouldScan(): boolean {
    if (!this.lastScanAt) return true;
    return Date.now() - this.lastScanAt.getTime() >= this.scanIntervalMs;
  }

  /**
   * Get time until next scan
   */
  getNextScanTime(): Date {
    if (!this.lastScanAt) {
      // If never scanned, next scan is interval from when scanner started
      return new Date(this.startedAt.getTime() + this.scanIntervalMs);
    }
    return new Date(this.lastScanAt.getTime() + this.scanIntervalMs);
  }

  /**
   * Run the autonomous scan
   */
  async scan(): Promise<ScanResult> {
    console.log('[SCAN] Starting autonomous scan...');
    this.lastScanAt = new Date();

    // 1. Get due cadences
    const dueCadences = this.responsibilityManager.getDueCadences();
    if (dueCadences.length > 0) {
      console.log(`[SCAN] Found ${dueCadences.length} due cadence(s)`);
    }

    // 2. Get responsibilities needing attention
    const needingAttention = this.responsibilityManager.getNeedingAttention(24);
    if (needingAttention.length > 0) {
      console.log(`[SCAN] Found ${needingAttention.length} responsibility(ies) needing attention`);
    }

    // 3. Get active goals without tasks
    const goalsWithoutTasks = this.goalManager.getActiveGoals().filter(
      (g) => g.taskIds.length === 0
    );

    // 4. Get recently completed tasks with findings
    const recentlyCompletedTasks = this.taskQueue.getAllTasks()
      .filter((t) => t.status === 'completed' && t.result)
      .filter((t) => {
        // Only tasks completed in last 48 hours
        const hoursSinceComplete = (Date.now() - t.updatedAt.getTime()) / (1000 * 60 * 60);
        return hoursSinceComplete <= 48;
      })
      .slice(0, 10); // Limit to 10 most recent

    // 5. Get ALL recent tasks (last 72 hours) to avoid creating duplicates
    const recentTasks = this.taskQueue.getAllTasks()
      .filter((t) => {
        const hoursSinceUpdate = (Date.now() - t.updatedAt.getTime()) / (1000 * 60 * 60);
        return hoursSinceUpdate <= 72;
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 30); // Limit to 30 most recent

    // If nothing needs attention, skip LLM call
    if (dueCadences.length === 0 && needingAttention.length === 0 && goalsWithoutTasks.length === 0 && recentlyCompletedTasks.length === 0) {
      console.log('[SCAN] Nothing needs attention');
      return {
        scannedAt: this.lastScanAt,
        dueCadences: [],
        needingAttention: [],
        tasksCreated: 0,
        nextScanAt: this.getNextScanTime(),
      };
    }

    // 6. Build context for LLM
    const planningPrompt = this.buildPlanningPrompt(dueCadences, needingAttention, goalsWithoutTasks, recentlyCompletedTasks, recentTasks);

    // 6. Invoke LLM with MCP tools - it will create goals, responsibilities, tasks, and context as needed
    let tasksCreated = 0;
    try {
      const stats = await this.planActions(planningPrompt);
      tasksCreated = stats.tasksCreated;

      console.log('[SCAN] Created:');
      if (stats.goalsCreated > 0) console.log(`  - ${stats.goalsCreated} goal(s)`);
      if (stats.responsibilitiesCreated > 0) console.log(`  - ${stats.responsibilitiesCreated} responsibility(ies)`);
      if (stats.tasksCreated > 0) console.log(`  - ${stats.tasksCreated} task(s)`);
      if (stats.contextStored > 0) console.log(`  - ${stats.contextStored} context item(s)`);
    } catch (error) {
      console.error('[SCAN] Error planning actions:', error);
    }

    console.log(`[SCAN] Complete.`);

    return {
      scannedAt: this.lastScanAt,
      dueCadences,
      needingAttention,
      tasksCreated,
      nextScanAt: this.getNextScanTime(),
    };
  }

  /**
   * Build the prompt for the LLM planner
   */
  private buildPlanningPrompt(
    dueCadences: Array<{ responsibility: Responsibility; cadence: Cadence }>,
    needingAttention: Responsibility[],
    goalsWithoutTasks: Array<{ id: string; title: string; description: string }>,
    recentlyCompletedTasks: Array<{ id: string; title: string; description: string; result?: string; context?: Record<string, unknown> }>,
    recentTasks: Array<{ id: string; title: string; description: string; status: string; updatedAt: Date }>
  ): string {
    const now = new Date();
    const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];

    let prompt = `# Autonomous Planning Session

Current time: ${now.toISOString()}
Day: ${dayOfWeek}

You are Deputy, an autonomous executive assistant. Review the following and determine what tasks should be created.

`;

    // Due cadences
    if (dueCadences.length > 0) {
      prompt += `## Due Cadences (scheduled activities that are now due)\n\n`;
      for (const { responsibility, cadence } of dueCadences) {
        prompt += `### ${cadence.name} (${responsibility.name})
- Domain: ${responsibility.domain}
- Phase: ${responsibility.phase ?? 'n/a'}
- Context: ${cadence.context ?? responsibility.description}
- People: ${responsibility.people.map((p) => p.name).join(', ') || 'none specified'}
- Channels: ${JSON.stringify(responsibility.channels)}

`;
      }
    }

    // Responsibilities needing attention
    if (needingAttention.length > 0) {
      prompt += `## Responsibilities Needing Attention (no activity in 24+ hours)\n\n`;
      for (const r of needingAttention) {
        prompt += `### ${r.name}
- Domain: ${r.domain}
- Phase: ${r.phase ?? 'n/a'}
- Description: ${r.description}
- Last attended: ${r.lastAttendedAt?.toISOString() ?? 'never'}
- Context: ${r.context.slice(-500) || 'none'}

`;
      }
    }

    // Goals without tasks
    if (goalsWithoutTasks.length > 0) {
      prompt += `## Goals Without Tasks (need decomposition)\n\n`;
      for (const g of goalsWithoutTasks) {
        prompt += `### ${g.title}
- Description: ${g.description}

`;
      }
    }

    // Recently completed tasks with findings
    if (recentlyCompletedTasks.length > 0) {
      prompt += `## Recently Completed Tasks (review for insights)\n\n`;
      for (const t of recentlyCompletedTasks) {
        prompt += `### ${t.title}
- Description: ${t.description}
- Result: ${t.result?.slice(0, 500)}${(t.result?.length ?? 0) > 500 ? '...' : ''}
- Task ID: ${t.id.slice(0, 8)}

`;
      }
    }

    // Recent tasks (to avoid duplicates)
    if (recentTasks.length > 0) {
      prompt += `## Recent Tasks (last 72 hours - avoid creating duplicates)\n\n`;
      for (const t of recentTasks) {
        const hoursAgo = Math.round((Date.now() - t.updatedAt.getTime()) / (1000 * 60 * 60));
        prompt += `- [${t.status}] ${t.title} (${hoursAgo}h ago)\n`;
      }
      prompt += '\n';
    }

    // Context summary
    const contextSummary = this.contextStore.buildContextSummary();
    if (contextSummary) {
      prompt += `## Accumulated Context\n\n${contextSummary}\n\n`;
    }

    prompt += `## Instructions

**IMPORTANT HIERARCHY - Follow this order:**

1. **Responsibility → Goal → Tasks** (preferred flow)
   - Responsibility: Ongoing area (e.g., "Elevated Priority meetings")
   - Goal: Specific outcome (e.g., "Conduct Jan 13 Elevated Priority meeting")
   - Tasks: Concrete actions (e.g., "Prepare agenda", "Create slides", "Send follow-ups")

2. **AVOID creating standalone Tasks** - Tasks should almost always have a parent Goal
   - Exception: Quick context-gathering tasks directly for a Responsibility

3. **Before creating Tasks, check if similar work was recently done**
   - Look at recently completed tasks in the same responsibility/goal
   - Don't duplicate work - build on what's already done

Use the available MCP tools:

**CreateGoal** - For finite outcomes with completion criteria (PREFER THIS OVER DIRECT TASKS)
  - Example: "Hire Compliance Assurance Head", "Conduct Monday Elevated Priority meeting"
  - Has a clear end state: hired, launched, completed, shipped
  - Link to parent responsibility if applicable

**CreateTask** - For concrete actions WITHIN A GOAL
  - ALWAYS link to parent goal via parentGoalId (except rare exceptions)
  - Link to responsibilities via context.responsibilityId
  - For cadences, include context.cadenceId
  - Check recent tasks first to avoid duplicates

**CreateResponsibility** - For ongoing areas of work without an end date
  - Example: "Weekly recruiting pipeline review", "Daily standup preparation"
  - Continues indefinitely with recurring cadences

**StoreContext** - To remember important context discovered
  - People involved, decisions made, requirements identified
  - Project details, processes, preferences

**UpdateGoal / UpdateResponsibility / UpdateTask** - To refine existing entities
  - Correct titles, descriptions, priorities
  - Adjust based on new information

**DeleteGoal / DeleteResponsibility / DeleteTask** - To remove obsolete entities
  - Clean up duplicates or mistakes
  - Remove completed goals or ended responsibilities

For completed tasks with findings, determine:
- Should this create a new Goal? (if findings reveal a finite objective)
- Should we store Context? (stakeholders, decisions, requirements discovered)
- Should we create follow-up Tasks WITHIN THE GOAL?
- Should we update or delete existing entities?

Consider:
- What specific outcome needs to be achieved? (Create Goal)
- What actions are needed to achieve that outcome? (Create Tasks under Goal)
- What ongoing work needs monitoring? (Create/update Responsibility)
- Has similar work been done recently? (Check before creating)
- Are there duplicates or obsolete items? (Delete them)

Use the tools to create, update, or delete as needed. If nothing requires attention, simply don't use any tools.
`;

    return prompt;
  }

  /**
   * Call LLM with MCP tools - Claude invokes tools directly
   * Uses the same deputy-tools MCP server as task execution for consistency
   */
  private async planActions(prompt: string): Promise<{
    tasksCreated: number;
    goalsCreated: number;
    responsibilitiesCreated: number;
    contextStored: number;
  }> {
    // Track what gets created via callbacks
    let goalsCreated = 0;
    let responsibilitiesCreated = 0;
    let contextStored = 0;
    let tasksCreated = 0;

    // Wrap callbacks to count invocations
    const countingCallbacks: CreationCallbacks = {
      createGoal: (params) => {
        goalsCreated++;
        return this.creationCallbacks.createGoal(params);
      },
      createResponsibility: (params) => {
        responsibilitiesCreated++;
        return this.creationCallbacks.createResponsibility(params);
      },
      createTask: (params) => {
        tasksCreated++;
        const result = this.creationCallbacks.createTask(params);

        // Mark cadence as triggered if applicable
        if (params.context?.responsibilityId && params.context?.cadenceId) {
          this.responsibilityManager.triggerCadence(
            params.context.responsibilityId as string,
            params.context.cadenceId as string
          );
        }

        // Mark responsibility as attended
        if (params.context?.responsibilityId) {
          const respId = params.context.responsibilityId as string;
          this.responsibilityManager.markAttended(respId);
          this.responsibilityManager.addActivity(respId, 'task_created', params.title, result.id);
        }

        return result;
      },
      storeContext: (params) => {
        contextStored++;
        return this.creationCallbacks.storeContext(params);
      },
    };

    // Temporarily swap callbacks for counting
    const originalCallbacks = this.creationCallbacks;
    (this as any).creationCallbacks = countingCallbacks;

    try {
      // Use MCP tools - same pattern as task execution
      for await (const message of query({
        prompt,
        options: {
          systemPrompt: 'You are Deputy\'s autonomous planning assistant. Use the available tools to create goals, responsibilities, tasks, and store knowledge based on what needs attention. Be proactive but thoughtful.',
          cwd: this.cwd,
          model: this.model,
          mcpServers: {
            "deputy-tools": this.mcpServerFactory()
          },
          allowedTools: [
            'mcp__deputy-tools__*', // Allow all deputy tools
          ],
        },
      })) {
        // Tools are invoked automatically
        // Just consume the messages
      }
    } finally {
      // Restore original callbacks
      (this as any).creationCallbacks = originalCallbacks;
    }

    return { tasksCreated, goalsCreated, responsibilitiesCreated, contextStored };
  }

  /**
   * Force a scan regardless of interval
   */
  async forceScan(): Promise<ScanResult> {
    this.lastScanAt = null;
    return this.scan();
  }

  /**
   * Set scan interval
   */
  setScanInterval(ms: number): void {
    this.scanIntervalMs = ms;
  }
}
