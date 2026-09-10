import type {
  MaestroTerminalLaunchProfile,
  MaestroTerminalRetentionPolicy
} from './maestro-terminal-lease'

export type MaestroTerminalLeaseTransferIdentity = {
  kind: MaestroTerminalLeaseTransferKind
  runId: string
  taskId: string
  attemptId: string
  terminalHandle: string
  ptyIncarnation: string
  processRootId: string | null
  executionHostId: string
  workspaceKey: string
  hostScope: string | null
  predecessorOwnerPrincipal: string
  successorOwnerPrincipal: string
  coordinatorGeneration: number | null
  launchProfile: MaestroTerminalLaunchProfile
  retentionPolicy: MaestroTerminalRetentionPolicy
}

export type MaestroTerminalLeaseTransferKind = 'strict_retry' | 'settled_resource_reuse'

export type MaestroTerminalLeaseTransferParticipantIdentity = {
  leaseId: string
  dispatchId: string
  ownerPrincipal: string
  runId: string
  taskId: string
  attemptId: string
  terminalHandle: string
  paneKey: string
  ptyIncarnation: string
  processRootId: string | null
  executionHostId: string
  workspaceKey: string
  hostScope: string | null
  coordinatorGeneration: number | null
  launchProfile: MaestroTerminalLaunchProfile
  retentionPolicy: MaestroTerminalRetentionPolicy
}

export type MaestroTerminalLeaseTransferReceipt = MaestroTerminalLeaseTransferIdentity & {
  version: 1
  requestId: string
  mutation: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
  } | null
  predecessorLeaseId: string
  successorLeaseId: string
  workerTerminalResourceId: string
  fromDispatchId: string
  toDispatchId: string
  predecessor: MaestroTerminalLeaseTransferParticipantIdentity
  successor: MaestroTerminalLeaseTransferParticipantIdentity
  transferredAt: string
}

export function matchesMaestroTerminalLeaseTransferIdentity(
  left: MaestroTerminalLeaseTransferIdentity,
  right: MaestroTerminalLeaseTransferIdentity
): boolean {
  return (
    left.kind === right.kind &&
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    left.attemptId === right.attemptId &&
    left.terminalHandle === right.terminalHandle &&
    left.ptyIncarnation === right.ptyIncarnation &&
    left.processRootId === right.processRootId &&
    left.executionHostId === right.executionHostId &&
    left.workspaceKey === right.workspaceKey &&
    left.hostScope === right.hostScope &&
    left.predecessorOwnerPrincipal === right.predecessorOwnerPrincipal &&
    left.successorOwnerPrincipal === right.successorOwnerPrincipal &&
    left.coordinatorGeneration === right.coordinatorGeneration &&
    left.retentionPolicy === right.retentionPolicy &&
    matchesMaestroTerminalLaunchProfile(left.launchProfile, right.launchProfile)
  )
}

export function matchesMaestroTerminalLaunchProfile(
  left: MaestroTerminalLaunchProfile,
  right: MaestroTerminalLaunchProfile
): boolean {
  return (
    left.agent === right.agent &&
    left.model === right.model &&
    left.effort === right.effort &&
    left.permissionMode === right.permissionMode &&
    left.routeRef === right.routeRef &&
    (left.serviceTier ?? null) === (right.serviceTier ?? null) &&
    (left.environmentPolicy ?? null) === (right.environmentPolicy ?? null)
  )
}
