// The background-tasks half of the agent-session wire: the per-task row, the
// roster state that carries it, and the field equality both the client reducer
// and the host status feed compare with. Split out of `agent-session-wire.ts`
// when that file reached its line budget; the definitions below are unchanged.

/** Per-task run state, reusing the agent-state vocabulary the dashboard already
 *  renders. Optional on the wire: an old host sends none and clients fall back
 *  to kind-derived defaults. */
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
  /** Provider-reported identity (e.g. a subagent type). `description` stays the
   *  display name; this is the fallback when the description is absent. */
  name?: string
  state?: AgentSessionBackgroundTaskRunState
  /** Host epoch ms when the task was first observed, so clients render elapsed. */
  startedAt?: number
  /** Cumulative provider-reported token usage, where the provider supplies it. */
  totalTokens?: number
  /** Whether this row's own stop can act on it. Absent means yes: every host
   *  that predates this field published only backgrounded, stoppable rows, and
   *  a client that read absence as "not stoppable" would hide a working control
   *  on those hosts. A row the host cannot target sends `false`. */
  stoppable?: boolean
}

export type AgentSessionBackgroundTaskState = {
  state: 'monitoring'
  /** Optional so mixed-version clients can consume state-only hosts. */
  tasks?: AgentSessionBackgroundTask[]
  /** Terminal-state siblings of a still-live roster, kept apart from `tasks`
   *  so old clients keep rendering exactly the live set they render today. */
  settledTasks?: AgentSessionBackgroundTask[]
  /** Optional so clients only send targeted stops to hosts that accept them. */
  supportsTaskStop?: boolean
  /** Whether an untargeted "stop everything" is available at all. Absent means
   *  yes: every host that predates this field accepted one, and a client that
   *  read absence as "no stop" would hide a working control on those hosts.
   *  A host whose provider exposes no honest stop sends `false`. */
  supportsStopAll?: boolean
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

/** Field equality for task lists, shared by the client reducer and the host
 *  status feed so a publish whose only change is one task's state is never
 *  judged equal and dropped. */
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
