import { z } from 'zod'
import { AgentGraphViewSchema, type AgentGraphView } from './maestro-contract'

const workspaceSchema = z
  .object({
    execution_host_id: z.string().min(1),
    workspace_key: z.string().min(1),
    kind: z.enum(['folder', 'git-worktree']),
    path: z.string().min(1),
    worktree_path: z.string().min(1).optional(),
    receipt_ref: z.string().optional()
  })
  .passthrough()
const profileSchema = z
  .object({
    requested: z
      .object({
        agent: z.string().nullable(),
        model: z.string().nullable(),
        effort: z.string().nullable()
      })
      .passthrough(),
    resolved: z
      .object({
        agent: z.string().nullable(),
        model: z.string().nullable(),
        effort: z.string().nullable()
      })
      .passthrough(),
    fallback_reason: z.string().nullable().optional(),
    resolved_placement: workspaceSchema.optional(),
    role: z.string().optional()
  })
  .passthrough()
const resourceSchema = z
  .object({
    execution_host_id: z.string().min(1).optional().catch(undefined),
    workspace_key: z.string().min(1).optional().catch(undefined),
    attempt_id: z.string().min(1).optional().catch(undefined),
    terminal_id: z.string().min(1).nullable().optional().catch(undefined),
    terminal_status: z.string().min(1).optional().catch(undefined),
    liveness: z.enum(['live', 'unverifiable', 'exited']).optional().catch(undefined)
  })
  .passthrough()

const STATUS_VERBS: Readonly<Record<string, string>> = {
  active: 'Running',
  approved: 'Archived',
  archived: 'Archived',
  cancelled: 'Archived',
  circuit_broken: 'Failed',
  blocked: 'Blocked',
  completed: 'Archived',
  dispatched: 'Running',
  exited: 'Archived',
  failed: 'Failed',
  finished: 'Archived',
  idle: 'Ready',
  input_required: 'Input required',
  'input-required': 'Input required',
  live: 'Running',
  outcome_unknown: 'Outcome unknown',
  pending: 'Queued',
  queued: 'Queued',
  ready: 'Ready',
  ready_to_release: 'Ready to release',
  'ready-to-release': 'Ready to release',
  reclaimable: 'Ready to release',
  release_pending: 'Ready to release',
  released: 'Archived',
  reserved: 'Queued',
  retained: 'Retained',
  running: 'Running',
  settled: 'Ready to release',
  starting: 'Starting',
  stopped: 'Archived',
  succeeded: 'Archived',
  superseded: 'Archived',
  unverifiable: 'Outcome unknown'
}

export const AgentGraphProjectionInputSchema = AgentGraphViewSchema
export type ParsedExecutionProfile = z.infer<typeof profileSchema>
export type ParsedExecutionResource = z.infer<typeof resourceSchema>
export type ProjectedWorkspace = {
  executionHostId: string
  workspaceKey: string
}

export function parseExecutionProfile(
  value: Record<string, unknown> | undefined
): ParsedExecutionProfile | undefined {
  return value ? profileSchema.safeParse(value).data : undefined
}

export function parseExecutionResource(
  value: Record<string, unknown> | undefined
): ParsedExecutionResource | undefined {
  return value ? resourceSchema.safeParse(value).data : undefined
}

export function displayGraphStatus(status: string): string {
  return STATUS_VERBS[status.toLowerCase()] ?? 'State unavailable'
}

export function workspaceFromIdentity(
  identity: AgentGraphView['workspace_scope']['execution_workspace']
): ProjectedWorkspace {
  return {
    executionHostId: identity.execution_host_id,
    workspaceKey: identity.workspace_key
  }
}

export function sameProjectedWorkspace(
  left: ProjectedWorkspace,
  right: ProjectedWorkspace
): boolean {
  return left.executionHostId === right.executionHostId && left.workspaceKey === right.workspaceKey
}

export function terminalReceiptIsLive(
  _status: string,
  resource: ParsedExecutionResource | undefined
): boolean {
  return resource?.liveness !== undefined
    ? resource.liveness === 'live'
    : resource?.terminal_status?.toLowerCase() === 'live'
}

function cursorMatches(
  previous: AgentGraphView['cursor'],
  fromCursor: AgentGraphView['from_cursor']
): boolean {
  if (!previous || !fromCursor) {
    return previous === null && fromCursor === null
  }
  return (
    previous.stream_id === fromCursor.stream_id &&
    previous.sequence === fromCursor.sequence &&
    previous.revision === fromCursor.revision
  )
}

export function assertAgentGraphDeltaContinuity(
  previous: AgentGraphView,
  delta: AgentGraphView
): void {
  if (delta.kind !== 'delta') {
    throw new Error('AgentGraphView update must be a delta.')
  }
  if (delta.reset_required) {
    throw new Error('AgentGraphView delta requires a fresh snapshot.')
  }
  const sameAuthority =
    previous.change === delta.change &&
    previous.run_id === delta.run_id &&
    previous.coordinator.id === delta.coordinator.id &&
    previous.coordinator.generation === delta.coordinator.generation &&
    JSON.stringify(previous.workspace_scope) === JSON.stringify(delta.workspace_scope)
  if (!sameAuthority) {
    throw new Error('AgentGraphView delta authority does not match the active projection.')
  }
  if (delta.revision <= previous.revision || !cursorMatches(previous.cursor, delta.from_cursor)) {
    throw new Error('AgentGraphView delta is stale or discontinuous.')
  }
}
