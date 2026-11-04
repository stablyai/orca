import type { WorkflowDefinition, WorkflowModelConfiguration } from './workflow-definition-schema'
import type { WorkflowMessageType } from './workflow-communication-schema'
import type { WorkflowWorkerReport } from './workflow-worker-result'

export type WorkflowRunStatus =
  | 'validating'
  | 'running'
  | 'paused'
  | 'awaiting-approval'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'

export type WorkflowTaskStatus =
  | 'pending'
  | 'ready'
  | 'dispatched'
  | 'running'
  | 'blocked'
  | 'awaiting-approval'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  /** The runtime could not prove what happened; never treated as success. */
  | 'unknown'

export type WorkflowEdgeState = 'pending' | 'taken' | 'not-taken'

/** One attempt at a task: exactly one Orca Dispatch, never reused across retries. */
export type WorkflowDispatch = {
  attempt: number
  /** Deterministic so a replayed start after a crash is recognised, not duplicated. */
  requestId: string
  orcaDispatchId: string | null
  orcaTerminalHandle: string | null
  /** The worker terminal's pane, so the UI can reveal it. */
  orcaPaneKey: string | null
  orcaWorktreeId: string | null
  state: 'starting' | 'running' | 'succeeded' | 'failed' | 'stopped' | 'unknown'
  requested: WorkflowModelConfiguration | null
  /** As Orca's worker-start receipt reported it; null until the start settles. */
  effective: { agent: string | null; model: string | null; effort: string | null } | null
  startedAt: string
  settledAt: string | null
  error: string | null
}

/** One execution of a node in one loop iteration, backed by its own Orca Task. */
export type WorkflowTask = {
  key: string
  nodeId: string
  iteration: number
  status: WorkflowTaskStatus
  /** loop: a bounded loop edge re-armed this task, so its forward inputs are not awaited. */
  activation: 'normal' | 'loop'
  orcaTaskId: string | null
  dispatches: WorkflowDispatch[]
  readyAt: string | null
  startedAt: string | null
  settledAt: string | null
  report: WorkflowWorkerReport | null
  approval: { gateId: string | null; resolution: 'approved' | 'rejected' | null } | null
  /** The assembled prompt sections, kept so the inspector shows exactly what was sent. */
  prompt: WorkflowAssembledPrompt | null
  error: string | null
}

export type WorkflowPromptSectionSource =
  | 'user-role'
  | 'user-shared'
  | 'user-task'
  | 'user-context'
  | 'user-output'
  | 'workflow-payload'
  | 'workflow-controller'

export type WorkflowAssembledPrompt = {
  sections: { title: string; source: WorkflowPromptSectionSource; text: string }[]
  text: string
  bytes: number
}

export type WorkflowMessageDeliveryState =
  | 'delivered'
  | 'rejected'
  | 'held'
  | 'truncated'
  | 'dropped-by-approval'

export type WorkflowMessage = {
  id: string
  runId: string
  edgeId: string | null
  sourceNodeId: string | null
  destinationNodeId: string | null
  taskKey: string | null
  orcaDispatchId: string | null
  orcaMessageId: string | null
  type: WorkflowMessageType
  /** controller: assembled into a downstream task; direct: a worker's own orchestration send. */
  channel: 'controller' | 'direct'
  timestamp: string
  correlationId: string
  payload: string
  payloadFormat: 'text' | 'json'
  deliveryState: WorkflowMessageDeliveryState
  /** When a held message was approved or dropped; its wait counts as communication wait. */
  releasedAt: string | null
  rejection: { code: string; reason: string } | null
  bytes: number
  estimatedTokens: number
}

export type WorkflowEventKind =
  | 'run-started'
  | 'run-paused'
  | 'run-resumed'
  | 'run-completed'
  | 'run-failed'
  | 'run-cancel-requested'
  | 'run-cancelled'
  | 'run-reconciled'
  | 'task-ready'
  | 'task-skipped'
  | 'agent-dispatched'
  | 'agent-started'
  | 'agent-start-failed'
  | 'task-completed'
  | 'task-failed'
  | 'task-unknown'
  | 'retry-scheduled'
  | 'loop-iteration'
  | 'approval-requested'
  | 'approval-resolved'
  | 'message-delivered'
  | 'message-rejected'
  | 'message-held'
  | 'question-received'
  | 'escalation-received'
  | 'budget-exhausted'
  | 'warning'

export type WorkflowEvent = {
  seq: number
  kind: WorkflowEventKind
  at: string
  nodeId: string | null
  taskKey: string | null
  orcaTaskId: string | null
  orcaDispatchId: string | null
  correlationId: string | null
  message: string
  data?: Record<string, string | number | boolean | null>
}

export type WorkflowRunPlacement = {
  /** Orca worktree selector (`id:<worktreeId>`) the coordinator terminal and `current` workers use. */
  worktreeSelector: string
  worktreeLabel: string
}

export type WorkflowRun = {
  schemaVersion: 1
  id: string
  presetId: string
  presetName: string
  objective: string
  /** Frozen copy: editing the preset never changes a run that already started. */
  definition: WorkflowDefinition
  placement: WorkflowRunPlacement
  status: WorkflowRunStatus
  schedulingPaused: boolean
  orcaRunId: string | null
  coordinatorTerminalHandle: string | null
  tasks: Record<string, WorkflowTask>
  edgeStates: Record<string, WorkflowEdgeState>
  loopCounts: Record<string, number>
  iterationByNode: Record<string, number>
  messages: WorkflowMessage[]
  events: WorkflowEvent[]
  nextEventSeq: number
  finalOutput: string | null
  createdAt: string
  startedAt: string | null
  settledAt: string | null
  error: string | null
}

export function workflowTaskKey(nodeId: string, iteration: number): string {
  return `${nodeId}#${iteration}`
}

export function isWorkflowRunTerminal(status: WorkflowRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function isWorkflowTaskSettled(status: WorkflowTaskStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'skipped' || status === 'cancelled'
  )
}
