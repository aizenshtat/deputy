/**
 * Core types for the Deputy autonomous agent system
 */

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
export type TaskStatus = 'pending' | 'in_progress' | 'waiting_approval' | 'approved' | 'completed' | 'failed' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
  dueDate?: Date;
  parentGoalId?: string;
  parentTaskId?: string;
  subtasks?: string[];
  assignedAgent?: string;
  context: Record<string, unknown>;
  result?: string;
  error?: string;
  approvalId?: string;
  tags: string[];
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: 'active' | 'completed' | 'paused' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
  taskIds: string[];
  progress: number; // 0-100
  context: Record<string, unknown>;
  tags: string[];
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  type: 'action' | 'decision' | 'communication' | 'expense' | 'access';
  title: string;
  description: string;
  details: Record<string, unknown>;
  proposedAction: string;
  alternatives?: string[];
  risk: 'low' | 'medium' | 'high';
  status: ApprovalStatus;
  createdAt: Date;
  respondedAt?: Date;
  response?: string;
  notes?: string;
}

export interface ContextEntry {
  id: string;
  category: 'person' | 'project' | 'company' | 'process' | 'decision' | 'preference' | 'knowledge';
  key: string;
  value: unknown;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  confidence: number; // 0-1
  tags: string[];
}

export interface DeputyState {
  isRunning: boolean;
  currentTaskId?: string;
  sessionId?: string;
  lastActivity: Date;
  stats: {
    tasksCompleted: number;
    tasksInProgress: number;
    pendingApprovals: number;
    activeGoals: number;
    activeResponsibilities: number;
  };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'deputy';
  content: string;
  timestamp: Date;
  relatedTaskIds?: string[];
  relatedApprovalIds?: string[];
}

export interface DeputyConfig {
  model?: string;
  workingDirectory: string;
  dataDirectory: string;
  pollingIntervalMs: number;
  maxConcurrentTasks: number;
  autoApproveThreshold: 'none' | 'low_risk' | 'medium_risk';
  notificationPreferences: {
    approvalNeeded: boolean;
    taskCompleted: boolean;
    errors: boolean;
  };
}

export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  specializations: string[];
}
