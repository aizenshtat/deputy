#!/usr/bin/env node
/**
 * Quick status check without starting the full agent
 */

import 'dotenv/config';
import { Persistence } from '../memory/persistence.js';

async function main(): Promise<void> {
  const dataDir = process.env.DEPUTY_DATA_DIR ?? './data';
  const persistence = new Persistence(dataDir);

  const data = await persistence.load();

  if (!data) {
    console.log('No Deputy state found. Run `npm start` to initialize.');
    return;
  }

  const { tasks, approvals, goals, state } = data;

  console.log('\n=== Deputy Status ===\n');
  console.log(`Last Active: ${state.lastActivity}`);
  console.log(`Running: ${state.isRunning}`);

  console.log('\n--- Goals ---');
  const activeGoals = goals.filter((g) => g.status === 'active');
  if (activeGoals.length === 0) {
    console.log('No active goals');
  } else {
    for (const goal of activeGoals) {
      console.log(`  [${goal.priority}] ${goal.title} - ${goal.progress}%`);
    }
  }

  console.log('\n--- Tasks ---');
  const tasksByStatus = {
    pending: tasks.filter((t) => t.status === 'pending'),
    in_progress: tasks.filter((t) => t.status === 'in_progress'),
    waiting_approval: tasks.filter((t) => t.status === 'waiting_approval'),
  };

  console.log(`  Pending: ${tasksByStatus.pending.length}`);
  console.log(`  In Progress: ${tasksByStatus.in_progress.length}`);
  console.log(`  Waiting Approval: ${tasksByStatus.waiting_approval.length}`);

  console.log('\n--- Pending Approvals ---');
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  if (pendingApprovals.length === 0) {
    console.log('No pending approvals');
  } else {
    for (const approval of pendingApprovals) {
      console.log(`  [${approval.risk}] ${approval.title}`);
      console.log(`    ID: ${approval.id}`);
      console.log(`    Action: ${approval.proposedAction}`);
    }
  }

  console.log('');
}

main().catch(console.error);
