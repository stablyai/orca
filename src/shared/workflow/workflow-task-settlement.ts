import { isWorkflowAgentNode } from './workflow-definition-schema'
import { forwardReachable, indexWorkflowExecution } from './workflow-graph-structure'
import { resolveWorkflowBranches } from './workflow-branch-resolution'
import { appendWorkflowEvent, currentWorkflowTask, findWorkflowNode } from './workflow-run-state'
import { isWorkflowRunTerminal, type WorkflowRun, type WorkflowTask } from './workflow-run-types'
import type { WorkflowWorkerReport } from './workflow-worker-result'

export type WorkflowSettlementResult = 'settled' | 'retry' | 'failed' | 'stale'

/** Only the current iteration's unsettled task may settle; anything else is a stale report. */
function liveTask(run: WorkflowRun, taskKey: string): WorkflowTask | null {
  const task = run.tasks[taskKey]
  if (!task || currentWorkflowTask(run, task.nodeId).key !== task.key) {
    return null
  }
  return task.status === 'dispatched' || task.status === 'running' || task.status === 'unknown'
    ? task
    : null
}

function maxAttempts(run: WorkflowRun, task: WorkflowTask): number {
  const node = findWorkflowNode(run.definition, task.nodeId)
  return isWorkflowAgentNode(node) ? node.agent.execution.maxAttempts : 1
}

/** Retry while attempts remain; otherwise fail the task and route the failure. */
export function failWorkflowTaskAttempt(
  run: WorkflowRun,
  taskKey: string,
  error: string,
  at: string,
  report: WorkflowWorkerReport | null = null
): WorkflowSettlementResult {
  const task = liveTask(run, taskKey)
  if (!task) {
    return 'stale'
  }
  const label = findWorkflowNode(run.definition, task.nodeId).label
  task.report = report ?? task.report
  if (task.dispatches.length < maxAttempts(run, task) && !isWorkflowRunTerminal(run.status)) {
    task.status = 'ready'
    task.error = error
    appendWorkflowEvent(
      run,
      'retry-scheduled',
      at,
      `${label} attempt ${task.dispatches.length} failed (${error}); retrying.`,
      { task }
    )
    return 'retry'
  }
  task.status = 'failed'
  task.error = error
  task.settledAt = at
  appendWorkflowEvent(run, 'task-failed', at, `${label} failed: ${error}`, { task })
  resolveWorkflowBranches(run, task, at)
  return 'failed'
}

export function completeWorkflowTask(
  run: WorkflowRun,
  taskKey: string,
  report: WorkflowWorkerReport,
  at: string
): WorkflowSettlementResult {
  const task = liveTask(run, taskKey)
  if (!task) {
    return 'stale'
  }
  if (report.outcome === 'failed') {
    return failWorkflowTaskAttempt(
      run,
      taskKey,
      report.subject || 'The worker reported failure.',
      at,
      report
    )
  }
  task.status = 'completed'
  task.report = report
  task.error = null
  task.settledAt = at
  appendWorkflowEvent(
    run,
    'task-completed',
    at,
    `${findWorkflowNode(run.definition, task.nodeId).label} completed: ${report.subject}`,
    { task }
  )
  resolveWorkflowBranches(run, task, at)
  return 'settled'
}

export function resolveWorkflowApproval(
  run: WorkflowRun,
  taskKey: string,
  resolution: 'approved' | 'rejected',
  at: string
): WorkflowSettlementResult {
  const task = run.tasks[taskKey]
  if (!task || task.status !== 'awaiting-approval') {
    return 'stale'
  }
  task.status = 'completed'
  task.approval = { gateId: task.approval?.gateId ?? null, resolution }
  task.settledAt = at
  appendWorkflowEvent(
    run,
    'approval-resolved',
    at,
    `${findWorkflowNode(run.definition, task.nodeId).label} was ${resolution}.`,
    { task }
  )
  resolveWorkflowBranches(run, task, at)
  return 'settled'
}

/** Manual retry: re-arm the task and anything its failure skipped, reopening a failed run. */
export function retryWorkflowTask(run: WorkflowRun, taskKey: string, at: string): boolean {
  const task = run.tasks[taskKey]
  if (
    !task ||
    currentWorkflowTask(run, task.nodeId).key !== task.key ||
    !(task.status === 'failed' || task.status === 'unknown' || task.status === 'cancelled')
  ) {
    return false
  }
  const downstream = forwardReachable(indexWorkflowExecution(run.definition), task.nodeId)
  const reset = new Set<string>([task.nodeId])
  for (const nodeId of downstream) {
    const candidate = currentWorkflowTask(run, nodeId)
    if (candidate.status === 'skipped' || candidate.status === 'cancelled') {
      candidate.status = 'pending'
      candidate.settledAt = null
      reset.add(nodeId)
    }
  }
  for (const edge of run.definition.dependencies) {
    if (!edge.loop && reset.has(edge.source)) {
      run.edgeStates[edge.id] = 'pending'
    }
  }
  task.status = 'ready'
  task.error = null
  task.settledAt = null
  if (isWorkflowRunTerminal(run.status)) {
    run.status = 'running'
    run.settledAt = null
    run.error = null
  }
  appendWorkflowEvent(
    run,
    'retry-scheduled',
    at,
    `${findWorkflowNode(run.definition, task.nodeId).label} retry requested.`,
    { task }
  )
  return true
}
