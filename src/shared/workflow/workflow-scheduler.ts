import { isWorkflowAgentNode, type WorkflowNode } from './workflow-definition-schema'
import { indexWorkflowExecution, workflowTopologicalOrder } from './workflow-graph-structure'
import { resolveWorkflowBranches, workflowFailureWasRouted } from './workflow-branch-resolution'
import {
  activeWorkflowAgentCount,
  appendWorkflowEvent,
  currentWorkflowTask,
  findWorkflowNode
} from './workflow-run-state'
import {
  isWorkflowRunTerminal,
  isWorkflowTaskSettled,
  type WorkflowRun,
  type WorkflowTask
} from './workflow-run-types'
import { aggregateWorkflowOutput } from './workflow-run-output'

export type WorkflowSchedulerAction =
  | { kind: 'dispatch-agent'; taskKey: string }
  | { kind: 'request-approval'; taskKey: string }
  | { kind: 'finalize'; status: 'completed' | 'failed'; reason: string | null }

type Readiness = 'ready' | 'skip' | 'wait'

function readiness(run: WorkflowRun, node: WorkflowNode, task: WorkflowTask): Readiness {
  if (task.activation === 'loop' || node.kind === 'start') {
    return 'ready'
  }
  const incoming = indexWorkflowExecution(run.definition).incoming.get(node.id) ?? []
  const states = incoming.map((edge) => run.edgeStates[edge.id] ?? 'pending')
  if (states.length === 0) {
    return 'wait'
  }
  if (node.kind === 'join' && node.mode === 'any' && states.includes('taken')) {
    return 'ready'
  }
  if (states.includes('pending')) {
    return 'wait'
  }
  return states.includes('taken') ? 'ready' : 'skip'
}

function settleControlNode(
  run: WorkflowRun,
  node: WorkflowNode,
  task: WorkflowTask,
  at: string
): void {
  task.status = 'completed'
  task.settledAt = at
  if (node.kind === 'end' && node.aggregate) {
    run.finalOutput = aggregateWorkflowOutput(run)
  }
  const error = resolveWorkflowBranches(run, task, at)
  if (error) {
    task.status = 'failed'
    task.error = error
    appendWorkflowEvent(run, 'task-failed', at, `${node.label}: ${error}`, { task })
  } else {
    appendWorkflowEvent(run, 'task-completed', at, `${node.label} settled.`, { task })
  }
}

function skipTask(run: WorkflowRun, node: WorkflowNode, task: WorkflowTask, at: string): void {
  task.status = 'skipped'
  task.settledAt = at
  for (const edge of run.definition.dependencies) {
    if (edge.source === node.id && !edge.loop) {
      run.edgeStates[edge.id] = 'not-taken'
    }
  }
  appendWorkflowEvent(run, 'task-skipped', at, `${node.label} was skipped: no branch led to it.`, {
    task
  })
}

function finalize(
  run: WorkflowRun,
  status: 'completed' | 'failed',
  reason: string | null,
  at: string
): WorkflowSchedulerAction {
  run.status = status
  run.settledAt = at
  run.error = status === 'failed' ? reason : null
  appendWorkflowEvent(
    run,
    status === 'completed' ? 'run-completed' : 'run-failed',
    at,
    reason ?? (status === 'completed' ? 'Workflow completed.' : 'Workflow failed.')
  )
  return { kind: 'finalize', status, reason }
}

function completionAction(run: WorkflowRun, at: string): WorkflowSchedulerAction | null {
  const tasks = run.definition.nodes.map((node) => currentWorkflowTask(run, node.id))
  const unrouted = tasks.filter(
    (task) => task.status === 'failed' && !workflowFailureWasRouted(run, task)
  )
  if (unrouted.length > 0 && run.definition.policies.failurePolicy === 'fail-fast') {
    const first = unrouted[0]
    const label = findWorkflowNode(run.definition, first.nodeId).label
    return finalize(run, 'failed', `${label} failed: ${first.error ?? 'no detail'}`, at)
  }
  const active = tasks.some(
    (task) => !isWorkflowTaskSettled(task.status) && task.status !== 'pending'
  )
  if (active) {
    return null
  }
  const pending = tasks.filter((task) => task.status === 'pending')
  if (pending.length > 0) {
    return finalize(run, 'failed', 'The workflow stalled: no task can become ready.', at)
  }
  const ended = run.definition.nodes.some(
    (node) => node.kind === 'end' && currentWorkflowTask(run, node.id).status === 'completed'
  )
  if (ended && unrouted.length === 0) {
    return finalize(run, 'completed', null, at)
  }
  return finalize(
    run,
    'failed',
    ended ? `${unrouted.length} task(s) failed.` : 'No End node was reached.',
    at
  )
}

/** Settle control nodes, mark ready work, and return the effects the controller must perform. */
export function advanceWorkflowRun(run: WorkflowRun, at: string): WorkflowSchedulerAction[] {
  if (isWorkflowRunTerminal(run.status) || run.status === 'cancelling') {
    return []
  }
  const order = workflowTopologicalOrder(run.definition)
  let changed = true
  while (changed) {
    changed = false
    for (const nodeId of order) {
      const node = findWorkflowNode(run.definition, nodeId)
      const task = currentWorkflowTask(run, nodeId)
      if (task.status !== 'pending') {
        continue
      }
      const verdict = readiness(run, node, task)
      if (verdict === 'wait') {
        continue
      }
      changed = true
      if (verdict === 'skip') {
        skipTask(run, node, task, at)
        continue
      }
      task.readyAt = at
      appendWorkflowEvent(run, 'task-ready', at, `${node.label} is ready.`, { task })
      if (isWorkflowAgentNode(node) || node.kind === 'approval') {
        task.status = 'ready'
      } else {
        settleControlNode(run, node, task, at)
      }
    }
  }
  const actions: WorkflowSchedulerAction[] = []
  if (!run.schedulingPaused) {
    let active = activeWorkflowAgentCount(run)
    for (const nodeId of order) {
      const node = findWorkflowNode(run.definition, nodeId)
      const task = currentWorkflowTask(run, nodeId)
      if (task.status !== 'ready') {
        continue
      }
      if (node.kind === 'approval') {
        task.status = 'awaiting-approval'
        actions.push({ kind: 'request-approval', taskKey: task.key })
      } else if (active < run.definition.policies.maxConcurrentAgents) {
        task.status = 'dispatched'
        active += 1
        actions.push({ kind: 'dispatch-agent', taskKey: task.key })
      }
    }
  }
  const awaiting = run.definition.nodes.some(
    (node) => currentWorkflowTask(run, node.id).status === 'awaiting-approval'
  )
  if (!run.schedulingPaused) {
    run.status = awaiting ? 'awaiting-approval' : 'running'
  }
  const done = completionAction(run, at)
  return done ? [...actions, done] : actions
}
