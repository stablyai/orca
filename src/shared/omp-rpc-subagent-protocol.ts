// Subagent forwarding sub-protocol (rpc.md "Subagent subscriptions").
//
// Forwarding is OFF by default: a client sees no subagent frame until it sends
// `set_subagent_subscription`. `progress` yields lifecycle + progress frames;
// `events` additionally forwards every subagent's own AgentSessionEvent stream.
// Payload shapes are canonical `SubagentLifecyclePayload` /
// `SubagentProgressPayload` / `SubagentEventPayload` and `AgentProgress`
// (packages/coding-agent/src/task/types.ts); only the fields a roster reads are
// typed, the rest passes through (D3 floor, as with `config_update.model`).

export const OMP_RPC_SUBAGENT_SUBSCRIPTION_LEVELS = ['off', 'progress', 'events'] as const
export type OmpRpcSubagentSubscriptionLevel = (typeof OMP_RPC_SUBAGENT_SUBSCRIPTION_LEVELS)[number]

/** `AgentProgress["status"]`. Lifecycle reports `started`, which upstream's own
 *  registry maps to `running`; the other three are terminal in both unions. */
export const OMP_RPC_SUBAGENT_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'aborted'
] as const
export type OmpRpcSubagentStatus = (typeof OMP_RPC_SUBAGENT_STATUSES)[number]

export const OMP_RPC_SUBAGENT_LIFECYCLE_STATUSES = [
  'started',
  'completed',
  'failed',
  'aborted'
] as const
export type OmpRpcSubagentLifecycleStatus = (typeof OMP_RPC_SUBAGENT_LIFECYCLE_STATUSES)[number]

export type OmpRpcSubagentProgress = {
  id: string
  index: number
  agent: string
  status: OmpRpcSubagentStatus
  task: string
  description?: string
  currentTool?: string
  toolCount?: number
  tokens?: number
  cost?: number
  durationMs?: number
} & Record<string, unknown>

export type OmpRpcSubagentLifecyclePayload = {
  id: string
  index: number
  agent: string
  status: OmpRpcSubagentLifecycleStatus
  description?: string
  sessionFile?: string
  parentToolCallId?: string
  /** Spawned as a detached background job — the parent turn keeps working. */
  detached?: boolean
} & Record<string, unknown>

export type OmpRpcSubagentProgressPayload = {
  index: number
  agent: string
  task: string
  progress: OmpRpcSubagentProgress
  assignment?: string
  sessionFile?: string
  parentToolCallId?: string
  detached?: boolean
} & Record<string, unknown>

/** One forwarded AgentSessionEvent from a subagent's own session, tagged with
 *  the subagent that produced it. The inner event is the same union the parent
 *  session emits, so it stays untyped here rather than re-declared. */
export type OmpRpcSubagentEventPayload = {
  id: string
  event: { type: string } & Record<string, unknown>
}

export type OmpRpcSubagentLifecycleFrame = {
  type: 'subagent_lifecycle'
  payload: OmpRpcSubagentLifecyclePayload
}

export type OmpRpcSubagentProgressFrame = {
  type: 'subagent_progress'
  payload: OmpRpcSubagentProgressPayload
}

export type OmpRpcSubagentEventFrame = {
  type: 'subagent_event'
  payload: OmpRpcSubagentEventPayload
}
