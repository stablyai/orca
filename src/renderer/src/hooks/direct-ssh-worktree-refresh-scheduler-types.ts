import type {
  HostQualifiedDetectedWorktreeResult,
  ProviderRequestId,
  SshExecutionHostId
} from '../../../shared/detected-worktree-provider-contract'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import type {
  DetectedWorktreeRefreshReleaseOutcome,
  WaiterLeaseId
} from '../store/slices/detected-worktree-refresh-leases'

export type { WaiterLeaseId } from '../store/slices/detected-worktree-refresh-leases'

export type DirectSshWorktreeRefreshAuthorityRequirement = 'required' | 'allow-metadata-fallback'

export type DirectSshWorktreeRefreshKey = DirectSshAuthority & {
  repoId: string
  executionHostId: SshExecutionHostId
  catalogRevision: number
  authorityRequirement: DirectSshWorktreeRefreshAuthorityRequirement
}

export type DirectSshWorktreeRefreshTerminalStatus =
  | 'complete'
  | 'non-authoritative'
  | 'timed-out'
  | 'cancel-budget-exhausted'
  | 'canceled'
  | 'stale'
  | 'rejected'

export type DirectSshWorktreeRefreshOutcome = {
  status: DirectSshWorktreeRefreshTerminalStatus
  providerRequestId?: ProviderRequestId
  providerResult?: HostQualifiedDetectedWorktreeResult
  metrics?: DirectSshWorktreeRefreshMetrics
}

export type DirectSshWorktreeRefreshMetrics = {
  queueWaitDurationsMs: readonly number[]
  providerExecutionDurationsMs: readonly number[]
  timeoutRetryCount: number
  locallySettledWaiterCount: number
  cancelDebtCount: number
  replacementAdmissionDelayedCount: number
  overlappingJoinCount: number
  peakLocallyUnsettled: number
  estimatedLateWorkAllowanceCount: number
}

export type DirectSshWorktreeRefreshReleaseReason = 'superseded' | 'invalidated' | 'stopped'

export type DirectSshWorktreeRefreshLease = {
  waiterLeaseId: WaiterLeaseId
  result: Promise<DirectSshWorktreeRefreshOutcome>
  release: (reason: DirectSshWorktreeRefreshReleaseReason) => void
}

export type DirectSshWorktreeRefreshAttempt = {
  providerRequestId: ProviderRequestId
  result: Promise<HostQualifiedDetectedWorktreeResult>
  cancel: (
    reason: DirectSshWorktreeRefreshReleaseReason
  ) => boolean | void | DetectedWorktreeRefreshReleaseOutcome
}

export type DirectSshWorktreeRefreshSchedulerDeps = {
  startAttempt: (key: DirectSshWorktreeRefreshKey) => DirectSshWorktreeRefreshAttempt
  createWaiterLeaseId?: () => WaiterLeaseId
  onUnexpectedError?: (error: unknown) => void
  now?: () => number
}

export type DirectSshWorktreeRefreshSchedulerSnapshot = {
  locallyUnsettled: number
  queued: number
  retrying: number
  logicalTasks: number
  waiters: number
  cancelDebtByAuthority: ReadonlyMap<string, number>
}

export type DirectSshWorktreeRefreshScheduler = {
  request: (key: DirectSshWorktreeRefreshKey) => DirectSshWorktreeRefreshLease
  invalidateAuthority: (authority: DirectSshAuthority) => void
  invalidateTarget: (targetId: string) => void
  disposeProvider: (authority: DirectSshAuthority) => void
  getSnapshot: () => DirectSshWorktreeRefreshSchedulerSnapshot
  stop: () => void
}

export type DirectSshWorktreeRefreshWaiter = {
  resolve: (outcome: DirectSshWorktreeRefreshOutcome) => void
}

export type DirectSshWorktreeRefreshLogicalTask = {
  key: DirectSshWorktreeRefreshKey
  keyId: string
  authorityId: string
  state: 'queued' | 'running' | 'retrying' | 'terminal'
  attemptCount: number
  attempt: DirectSshWorktreeRefreshAttempt | null
  attemptCanceled: boolean
  attemptStartedAt: number | null
  queuedAt: number
  metrics: DirectSshWorktreeRefreshMetrics
  waiters: Map<WaiterLeaseId, DirectSshWorktreeRefreshWaiter>
}

export function directSshProviderAuthorityKey(authority: DirectSshAuthority): string {
  return JSON.stringify([
    authority.targetId,
    authority.providerEpoch,
    authority.connectionGeneration
  ])
}

export function directSshWorktreeRefreshKey(key: DirectSshWorktreeRefreshKey): string {
  return JSON.stringify([
    key.targetId,
    key.repoId,
    key.executionHostId,
    key.providerEpoch,
    key.connectionGeneration,
    key.catalogRevision,
    key.authorityRequirement
  ])
}
