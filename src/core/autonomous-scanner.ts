/**
 * Autonomous Scanner - Utility class for planning timing and prompt building
 *
 * Planning execution is now handled inline in deputy.ts to avoid subprocess issues.
 * This class provides:
 * 1. Timing logic (shouldScan, getNextScanTime)
 * 2. Prompt building (buildPlanningPrompt)
 */

import { ResponsibilityManager, Responsibility, Cadence } from '../memory/responsibilities.js';
import { TaskQueue } from './task-queue.js';
import { ContextStore } from '../memory/context-store.js';
import { GoalManager } from '../memory/goals.js';

// Type kept for backward compatibility with deputy.ts constructor
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

  private lastScanAt: Date | null = null;
  private scanIntervalMs: number;
  private startedAt: Date;

  constructor(params: {
    responsibilityManager: ResponsibilityManager;
    taskQueue: TaskQueue;
    contextStore: ContextStore;
    goalManager: GoalManager;
    scanIntervalMs?: number;
    // Legacy params kept for backward compatibility (not used)
    creationCallbacks?: any;
    mcpServerFactory?: any;
    sendChatMessage?: any;
    model?: string;
    cwd?: string;
  }) {
    this.responsibilityManager = params.responsibilityManager;
    this.taskQueue = params.taskQueue;
    this.contextStore = params.contextStore;
    this.goalManager = params.goalManager;
    this.scanIntervalMs = params.scanIntervalMs ?? 30 * 60 * 1000; // 30 min default
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
   * Mark that a scan was performed (called by deputy.ts after inline planning)
   */
  markScanned(): void {
    this.lastScanAt = new Date();
  }

  /**
   * Build the prompt for the LLM planner
   * Returns null if nothing needs attention
   */
  buildPlanningPrompt(): string | null {
    // 1. Get due cadences
    const dueCadences = this.responsibilityManager.getDueCadences();

    // 2. Get responsibilities needing attention
    const needingAttention = this.responsibilityManager.getNeedingAttention(24);

    // 3. Get active goals without tasks
    const goalsWithoutTasks = this.goalManager.getActiveGoals().filter(
      (g) => g.taskIds.length === 0
    );

    // 4. Get recently completed tasks with findings
    const recentlyCompletedTasks = this.taskQueue.getAllTasks()
      .filter((t) => t.status === 'completed' && t.result)
      .filter((t) => {
        const hoursSinceComplete = (Date.now() - t.updatedAt.getTime()) / (1000 * 60 * 60);
        return hoursSinceComplete <= 48;
      })
      .slice(0, 10);

    // 5. Get ALL recent tasks (last 72 hours) to avoid creating duplicates
    const recentTasks = this.taskQueue.getAllTasks()
      .filter((t) => {
        const hoursSinceUpdate = (Date.now() - t.updatedAt.getTime()) / (1000 * 60 * 60);
        return hoursSinceUpdate <= 72;
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 30);

    // If nothing needs attention, return null
    if (dueCadences.length === 0 && needingAttention.length === 0 && goalsWithoutTasks.length === 0 && recentlyCompletedTasks.length === 0) {
      return null;
    }
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

**CRITICAL: You work in the browser, NOT with local files**
- NEVER create tasks about .md files or local documents
- ALL documents must be Google Docs, Sheets, or Slides created via browser
- ALL emails must be Gmail drafts created via browser
- Tasks should specify "Create Google Doc" not "Create document"
- Example GOOD task: "Create Google Doc with recruitment strategy"
- Example BAD task: "Create recruitment_strategy.md file"

**IMPORTANT HIERARCHY - Follow this order:**

1. **Responsibility → Goal → Tasks** (preferred flow)
   - Responsibility: Ongoing area (e.g., "Elevated Priority meetings")
   - Goal: Specific outcome (e.g., "Conduct Jan 13 Elevated Priority meeting")
   - Tasks: Concrete actions (e.g., "Create Google Doc with agenda", "Compose Gmail draft to team")

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
   * Force a scan regardless of interval (resets timer)
   */
  forceScan(): void {
    this.lastScanAt = null;
  }

  /**
   * Set scan interval
   */
  setScanInterval(ms: number): void {
    this.scanIntervalMs = ms;
  }
}
