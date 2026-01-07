#!/usr/bin/env node
/**
 * Approve or reject pending approvals from command line
 */

import 'dotenv/config';
import { Persistence } from '../memory/persistence.js';
import { ApprovalQueue } from '../core/approval-queue.js';
import { TaskQueue } from '../core/task-queue.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage:');
    console.log('  npm run approve list          - List pending approvals');
    console.log('  npm run approve <id>          - Approve by ID');
    console.log('  npm run approve reject <id>   - Reject by ID');
    return;
  }

  const dataDir = process.env.DEPUTY_DATA_DIR ?? './data';
  const persistence = new Persistence(dataDir);
  await persistence.init();

  const data = await persistence.load();

  if (!data) {
    console.log('No Deputy state found. Run `npm start` to initialize.');
    return;
  }

  const approvalQueue = new ApprovalQueue(data.approvals);
  const taskQueue = new TaskQueue(data.tasks);

  if (args[0] === 'list') {
    const pending = approvalQueue.getPending();
    if (pending.length === 0) {
      console.log('No pending approvals.');
      return;
    }

    console.log('\n=== Pending Approvals ===\n');
    for (const approval of pending) {
      console.log(`[${approval.risk.toUpperCase()}] ${approval.title}`);
      console.log(`  ID: ${approval.id}`);
      console.log(`  Task: ${approval.taskId}`);
      console.log(`  Type: ${approval.type}`);
      console.log(`  Action: ${approval.proposedAction}`);
      console.log(`  Description: ${approval.description}`);
      console.log('');
    }
    return;
  }

  if (args[0] === 'reject') {
    const approvalId = args[1];
    const reason = args.slice(2).join(' ') || 'Rejected via CLI';

    if (!approvalId) {
      console.log('Usage: npm run approve reject <id> [reason]');
      return;
    }

    const approval = approvalQueue.reject(approvalId, reason);
    if (approval) {
      taskQueue.updateTaskStatus(approval.taskId, 'cancelled');

      // Save changes
      data.approvals = approvalQueue.toJSON();
      data.tasks = taskQueue.toJSON();
      await persistence.saveImmediate(data);

      console.log(`Rejected: ${approval.title}`);
      console.log(`Reason: ${reason}`);
    } else {
      console.log('Approval not found or already processed.');
    }
    return;
  }

  // Default: approve
  const approvalId = args[0];
  const approval = approvalQueue.approve(approvalId);

  if (approval) {
    taskQueue.approveTask(approval.taskId);

    // Save changes
    data.approvals = approvalQueue.toJSON();
    data.tasks = taskQueue.toJSON();
    await persistence.saveImmediate(data);

    console.log(`Approved: ${approval.title}`);
    console.log(`Task ${approval.taskId} will resume on next Deputy run.`);
  } else {
    console.log('Approval not found or already processed.');
  }
}

main().catch(console.error);
