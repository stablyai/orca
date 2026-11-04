import type { WorkflowExecutionDependency } from './workflow-definition-schema'
import {
  evaluateWorkflowCondition,
  type WorkflowConditionSubject
} from './workflow-condition-evaluation'
import { indexWorkflowExecution, workflowLoopRegion } from './workflow-graph-structure'
import {
  appendWorkflowEvent,
  createWorkflowTask,
  currentWorkflowTask,
  findWorkflowNode
} from './workflow-run-state'
import type { WorkflowRun, WorkflowTask } from './workflow-run-types'

/** What outgoing conditions read: a decision reads its subject; everything else reads itself. */
export function workflowConditionSubject(
  run: WorkflowRun,
  task: WorkflowTask
): WorkflowConditionSubject {
  const node = findWorkflowNode(run.definition, task.nodeId)
  let source = task
  if (node.kind === 'decision') {
    const index = indexWorkflowExecution(run.definition)
    const subjectId = node.subjectNodeId ?? index.incoming.get(node.id)?.[0]?.source
    if (subjectId) {
      source = currentWorkflowTask(run, subjectId)
    }
  }
  const outcome =
    source.status === 'completed' ? 'succeeded' : source.status === 'failed' ? 'failed' : null
  return {
    outcome: source.report?.outcome ?? outcome,
    approval: source.approval?.resolution ?? null,
    data: source.report?.data ?? {}
  }
}

function edgeMatches(
  edge: WorkflowExecutionDependency,
  subject: WorkflowConditionSubject,
  nodeSucceeded: boolean
): boolean {
  // An unconditioned edge is the success path; failures leave only by an explicit outcome edge.
  return edge.condition ? evaluateWorkflowCondition(edge.condition, subject) : nodeSucceeded
}

/** Re-arm every node between a loop edge's target and source for one more iteration. */
function takeLoop(run: WorkflowRun, edge: WorkflowExecutionDependency, at: string): void {
  run.loopCounts[edge.id] = (run.loopCounts[edge.id] ?? 0) + 1
  const region = workflowLoopRegion(run.definition, edge)
  for (const nodeId of region) {
    const iteration = (run.iterationByNode[nodeId] ?? 0) + 1
    run.iterationByNode[nodeId] = iteration
    const next = createWorkflowTask(nodeId, iteration)
    if (nodeId === edge.target) {
      next.activation = 'loop'
    }
    run.tasks[next.key] = next
  }
  for (const dependency of run.definition.dependencies) {
    if (!dependency.loop && region.has(dependency.source)) {
      run.edgeStates[dependency.id] = 'pending'
    }
  }
  appendWorkflowEvent(
    run,
    'loop-iteration',
    at,
    `Loop ${edge.label || edge.id} re-runs ${region.size} node(s) (iteration ${run.loopCounts[edge.id]} of ${edge.loop?.maxIterations}).`,
    { nodeId: edge.target, data: { edgeId: edge.id, iteration: run.loopCounts[edge.id] ?? 0 } }
  )
}

function loopAvailable(run: WorkflowRun, edge: WorkflowExecutionDependency): boolean {
  return (run.loopCounts[edge.id] ?? 0) < (edge.loop?.maxIterations ?? 0)
}

/**
 * Resolve a settled task's outgoing edges. Returns an error when a decision finds no branch, which
 * the caller turns into a task failure.
 */
export function resolveWorkflowBranches(
  run: WorkflowRun,
  task: WorkflowTask,
  at: string
): string | null {
  const node = findWorkflowNode(run.definition, task.nodeId)
  const outgoing = run.definition.dependencies.filter((edge) => edge.source === task.nodeId)
  const subject = workflowConditionSubject(run, task)
  // A rejected approval settles its task but must not take the unconditioned (approved) path.
  const succeeded = task.status === 'completed' && task.approval?.resolution !== 'rejected'
  if (node.kind === 'decision') {
    // Conditioned branches win in definition order; the unconditioned one is the fallback.
    const ordered = [
      ...outgoing.filter((edge) => edge.condition !== null),
      ...outgoing.filter((edge) => edge.condition === null)
    ]
    const exhausted: string[] = []
    const chosen = ordered.find((edge) => {
      const matches = edge.condition ? evaluateWorkflowCondition(edge.condition, subject) : true
      if (matches && edge.loop && !loopAvailable(run, edge)) {
        exhausted.push(edge.label || edge.id)
        return false
      }
      return matches
    })
    if (!chosen) {
      for (const edge of outgoing.filter((candidate) => !candidate.loop)) {
        run.edgeStates[edge.id] = 'not-taken'
      }
      return exhausted.length > 0
        ? `Revision limit reached on ${exhausted.join(', ')} and no other branch matched.`
        : 'No decision branch matched the result.'
    }
    if (chosen.loop) {
      takeLoop(run, chosen, at)
      return null
    }
    for (const edge of outgoing.filter((candidate) => !candidate.loop)) {
      run.edgeStates[edge.id] = edge.id === chosen.id ? 'taken' : 'not-taken'
    }
    return null
  }
  const loop = outgoing.find(
    (edge) => edge.loop && edgeMatches(edge, subject, succeeded) && loopAvailable(run, edge)
  )
  if (loop) {
    takeLoop(run, loop, at)
    return null
  }
  for (const edge of outgoing.filter((candidate) => !candidate.loop)) {
    run.edgeStates[edge.id] = edgeMatches(edge, subject, succeeded) ? 'taken' : 'not-taken'
  }
  return null
}

/** True when a failure left by an explicit outcome:failed edge, so fail-fast does not apply. */
export function workflowFailureWasRouted(run: WorkflowRun, task: WorkflowTask): boolean {
  return run.definition.dependencies.some(
    (edge) =>
      edge.source === task.nodeId &&
      edge.condition !== null &&
      (run.edgeStates[edge.id] === 'taken' ||
        (edge.loop !== null && task.iteration < (run.iterationByNode[task.nodeId] ?? 0)))
  )
}
