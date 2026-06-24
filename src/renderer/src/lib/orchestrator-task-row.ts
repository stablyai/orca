import type { AgentDotState } from '@/components/AgentStateDot'
import type { OrchestrationRunDag, OrchestrationTaskNode } from '../../../shared/runtime-types'

// Why (#7 O2): map a task node's DB status (+ dispatch liveness) onto the shared
// AgentStateDot vocabulary so the Control Panel reuses the same status visuals as
// the rest of the app instead of inventing new ones. Mirrors the field mapping in
// issue #7: pending/ready=idle, dispatched=working (stalled when the heartbeat is
// past the hung threshold), blocked=blocked, completed=done, failed=interrupted.
export function deriveTaskDotState(node: OrchestrationTaskNode): AgentDotState {
  switch (node.status) {
    case 'pending':
    case 'ready':
      return 'idle'
    case 'dispatched':
      return node.dispatch?.stale ? 'stalled' : 'working'
    case 'blocked':
      return 'blocked'
    case 'completed':
      return 'done'
    case 'failed':
      return 'interrupted'
  }
}

// Why (#7): a stable token (not English) so the row component can route the
// short status word through i18n. Matches the storyboard mock vocabulary.
export type TaskStatusLabel = 'queued' | 'working' | 'stalled' | 'blocked' | 'done' | 'failed'

export function deriveTaskStatusLabel(node: OrchestrationTaskNode): TaskStatusLabel {
  switch (node.status) {
    case 'pending':
    case 'ready':
      return 'queued'
    case 'dispatched':
      return node.dispatch?.stale ? 'stalled' : 'working'
    case 'blocked':
      return 'blocked'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
  }
}

/** The first dependency that is not yet completed, by title — what a
 *  queued/blocked task is waiting on. Null when there is none, or when the
 *  blocking dep isn't in the synced set (truncated past the cap / unknown) so
 *  the row can omit the hint rather than render a raw uuid. */
function firstUnmetDepTitle(
  node: OrchestrationTaskNode,
  nodesById: Map<string, OrchestrationTaskNode>
): string | null {
  for (const depId of node.deps) {
    const dep = nodesById.get(depId)
    if (dep && dep.status === 'completed') {
      continue
    }
    return dep ? dep.title : null
  }
  return null
}

// Why (#7): the row's message is either live worker content (rendered verbatim —
// not translatable) or a "waiting on <dep>" hint (translated by the component).
// Returns null when there is nothing meaningful to say.
export type TaskMessage = { kind: 'signal'; text: string } | { kind: 'waiting'; dep: string } | null

export function deriveTaskMessage(
  node: OrchestrationTaskNode,
  nodesById: Map<string, OrchestrationTaskNode>
): TaskMessage {
  if (node.signal?.summary) {
    return { kind: 'signal', text: node.signal.summary }
  }
  if (node.signal?.phase) {
    return { kind: 'signal', text: node.signal.phase }
  }
  if (node.status === 'pending' || node.status === 'blocked') {
    const dep = firstUnmetDepTitle(node, nodesById)
    if (dep) {
      return { kind: 'waiting', dep }
    }
  }
  return null
}

export function indexTaskNodes(dag: OrchestrationRunDag): Map<string, OrchestrationTaskNode> {
  return new Map(dag.tasks.map((task) => [task.id, task]))
}
