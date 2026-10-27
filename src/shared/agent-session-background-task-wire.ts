// Background task wire rows and roster; keep task equality consistent across host publication and client reduction.

import type { AgentChildWorkView } from './agent-status-child-work-view'

/** Optional state uses dashboard vocabulary; older hosts fall back to kind-derived defaults. */
export type AgentSessionBackgroundTaskRunState =
  | 'working'
  | 'monitoring'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'idle'
  | 'unverifiable'

export type AgentSessionBackgroundTask = {
  id: string
  kind: 'agent' | 'workflow' | 'command' | 'monitor' | 'unknown'
  description?: string
  /** Provider identity is a fallback name; description remains the display label. */
  name?: string
  state?: AgentSessionBackgroundTaskRunState
  /** Host epoch ms when the task was first observed, so clients render elapsed. */
  startedAt?: number
  /** Cumulative provider-reported token usage, where the provider supplies it. */
  totalTokens?: number
  /** Absent means stoppable for older hosts, which published only targetable tasks; unsupported targets explicitly send false. */
  stoppable?: boolean
}

export type AgentSessionBackgroundTaskState = {
  state: 'monitoring'
  /** Optional so mixed-version clients can consume state-only hosts. */
  tasks?: AgentSessionBackgroundTask[]
  /** Keep settled rows separate so older clients still render only live tasks. */
  settledTasks?: AgentSessionBackgroundTask[]
  /** Optional so clients only send targeted stops to hosts that accept them. */
  supportsTaskStop?: boolean
  /** Absent means stop-all supported for older hosts; providers without a valid stop must send false. */
  supportsStopAll?: boolean
  /** Host child views derive live/settled task rows; only background-task-child-views.v1 clients may receive settled-only rosters. */
  children?: AgentChildWorkView[]
  /** Unlisted/refused/dropped child work remains live; absence proves no end. Clear missing evidence on admission, its own end or session end. */
  incomplete?: true
}

function backgroundTaskFieldsEqual(
  left: AgentSessionBackgroundTask,
  right: AgentSessionBackgroundTask
): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.description === right.description &&
    left.name === right.name &&
    left.state === right.state &&
    left.startedAt === right.startedAt &&
    left.totalTokens === right.totalTokens &&
    left.stoppable === right.stoppable
  )
}

/** Share equality across host/client so a task-state-only change cannot be dropped. */
export function agentSessionBackgroundTasksEqual(
  left: AgentSessionBackgroundTask[] | undefined,
  right: AgentSessionBackgroundTask[] | undefined
): boolean {
  if (left === right) {
    return true
  }
  if (!left || !right || left.length !== right.length) {
    return false
  }
  return left.every((task, index) => backgroundTaskFieldsEqual(task, right[index]))
}
