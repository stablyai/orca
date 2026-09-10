import type { PtyStopReceipt } from './pty-stop-receipt'
import type { TuiAgent } from './tui-agent'

export const MAESTRO_TERMINAL_LEASE_STATES = [
  'reserved',
  'starting',
  'ready',
  'active',
  'input_required',
  'settled',
  'retained',
  'release_pending',
  'released',
  'outcome_unknown',
  'superseded',
  'archived'
] as const

export type MaestroTerminalLeaseState = (typeof MAESTRO_TERMINAL_LEASE_STATES)[number]
export type MaestroTerminalLeaseRole = 'coordinator' | 'worker'
export type MaestroTerminalRetentionPolicy = 'auto_release' | 'retain'
export type MaestroTerminalLeaseObservation =
  | 'context_rollover'
  | 'correction_exit'
  | 'launch_profile_drift'

export type MaestroTerminalLaunchProfile = {
  agent: TuiAgent | null
  model: string | null
  effort: string | null
  permissionMode: string
  routeRef: string | null
  serviceTier?: 'default' | 'fast' | null
  environmentPolicy?: string | null
}

export type MaestroTerminalCleanupReceipt = {
  verdict: 'exited' | 'unverifiable'
  processTreeVerified: boolean
  closedTerminalHandle: string | null
  replacementTerminalHandle: string | null
  replacementIncarnation: string | null
  archiveRef: string | null
  observedAt: string
  providerStopReceipt?: PtyStopReceipt
}

export type MaestroTerminalLeaseReconciliationResult = {
  leaseId: string
  action: 'released' | 'retained' | 'delegated_to_worker_release' | 'outcome_unknown'
  cleanupReceipt: MaestroTerminalCleanupReceipt | null
}

export type MaestroTerminalLease = {
  id: string
  requestId: string
  executionHostId: string
  workspaceKey: string
  terminalHandle: string | null
  tabId: string | null
  paneKey: string | null
  ptyIncarnation: string | null
  processRootId: string | null
  runId: string
  taskId: string | null
  attemptId: string | null
  coordinatorGeneration: number | null
  role: MaestroTerminalLeaseRole
  workerTerminalResourceId: string | null
  coordinatorRunId: string | null
  title: string
  launchProfile: MaestroTerminalLaunchProfile
  parentLeaseId: string | null
  spawnedBy: string
  ownerPrincipal: string
  retentionPolicy: MaestroTerminalRetentionPolicy
  lifecycleState: MaestroTerminalLeaseState
  observation: MaestroTerminalLeaseObservation | null
  providerSessionId: string | null
  capsuleDigest: string | null
  cleanupReceipt: MaestroTerminalCleanupReceipt | null
  archivedTail: string | null
  createdAt: string
  updatedAt: string
}

export const TERMINAL_INPUT_RECEIPT_STATES = [
  'accepted',
  'queued',
  'written_to_pty',
  'acknowledged',
  'rejected',
  'superseded',
  'delivery_unknown'
] as const

export type TerminalInputReceiptState = (typeof TERMINAL_INPUT_RECEIPT_STATES)[number]
export type TerminalInputSurface = 'ready_prompt' | 'working' | 'permission' | 'input_required'

export type MaestroTerminalInputSender = {
  principalId: string
  authority: 'coordinator' | 'worker' | 'user'
  runId: string
  coordinatorGeneration: number | null
}

export type MaestroTerminalInputEnvelope = {
  commandId: string
  idempotencyKey: string
  contentDigest: string
  enqueueSequence: number
  sender: MaestroTerminalInputSender
  leaseId: string
  executionHostId: string
  workspaceKey: string
  terminalHandle: string
  tabId: string
  ptyIncarnation: string
  expectedLifecycleState: MaestroTerminalLeaseState
  observedInputSurface: TerminalInputSurface
  expiresAt: string
  expectedGraphRevision: number | null
}

export type MaestroTerminalInputReceipt = MaestroTerminalInputEnvelope & {
  state: TerminalInputReceiptState
  bytesWritten: number
  enterWritten: boolean
  acknowledgedGraphRevision: number | null
  supersededByCommandId: string | null
  rejectionCode: string | null
  createdAt: string
  updatedAt: string
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<MaestroTerminalLeaseState, readonly MaestroTerminalLeaseState[]>
> = {
  reserved: ['starting', 'retained', 'outcome_unknown'],
  starting: ['ready', 'retained', 'outcome_unknown'],
  ready: ['active', 'input_required', 'settled', 'retained', 'outcome_unknown'],
  active: ['input_required', 'settled', 'retained', 'outcome_unknown'],
  input_required: ['active', 'settled', 'retained', 'outcome_unknown'],
  settled: ['retained', 'release_pending'],
  retained: ['active', 'settled', 'release_pending', 'outcome_unknown'],
  release_pending: ['released', 'retained', 'outcome_unknown'],
  released: ['archived'],
  outcome_unknown: ['retained', 'release_pending'],
  superseded: [],
  archived: []
}

export function canTransitionMaestroTerminalLease(
  from: MaestroTerminalLeaseState,
  to: MaestroTerminalLeaseState
): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to)
}

export function canReleaseMaestroTerminalLease(
  lease: Pick<MaestroTerminalLease, 'role' | 'lifecycleState' | 'coordinatorGeneration'>,
  currentCoordinatorGeneration: number | null
): boolean {
  if (lease.role === 'worker') {
    return lease.lifecycleState === 'settled' || lease.lifecycleState === 'retained'
  }
  return (
    lease.coordinatorGeneration !== null &&
    currentCoordinatorGeneration !== null &&
    lease.coordinatorGeneration < currentCoordinatorGeneration &&
    (lease.lifecycleState === 'settled' || lease.lifecycleState === 'retained')
  )
}

export function buildMaestroTerminalLeaseTitle(params: {
  role: MaestroTerminalLeaseRole
  runId: string
  taskId?: string | null
  coordinatorGeneration?: number | null
  agent?: string | null
}): string {
  const agent = params.agent?.trim() || 'Agent'
  if (params.role === 'coordinator') {
    const generation = params.coordinatorGeneration ?? 0
    return `Harness · coordinator g${generation} · ${agent}`
  }
  return `${params.taskId?.trim() || params.runId.trim()} · worker · ${agent}`
}

export function isSha256Digest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value)
}
