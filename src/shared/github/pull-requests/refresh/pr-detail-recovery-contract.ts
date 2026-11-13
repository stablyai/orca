import type { PRRefreshOutcome } from './pull-request-refresh-types'

/** Advertised only by hosts whose start/wait/commit/cancel run the queued recovery ticket. */
export const GITHUB_PR_DETAIL_RECOVERY_RUNTIME_CAPABILITY = 'github.pr-detail-recovery.v2' as const

export const PR_DETAIL_RECOVERY_WAIT_MAX_MS = 20_000
export const PR_DETAIL_RECOVERY_PREPARE_TTL_MS = 20_000
export const PR_DETAIL_RECOVERY_SETTLE_BUDGET_MS = 30_000
export const PR_DETAIL_RECOVERY_LEASE_MS = 60_000
export const PR_DETAIL_RECOVERY_RETENTION_MS = 60_000
export const PR_DETAIL_RECOVERY_MAX_TICKETS = 1_000

/** Correlation metadata only: the host re-derives paths, owner and execution from its registry. */
export type PRDetailRecoveryIdentity = {
  /** Caller-chosen source epoch (renderer/runtime pairing instance). */
  sourceEpoch: string
  repoId: string
  repoPath: string
  worktreeId: string
  branch: string
  currentHeadOid: string | null
  executionHostId: string | null
  provider: 'github'
  linkedPRNumber: number | null
  fallbackPRNumber: number | null
  fallbackPRSource: 'explicit' | 'pr-cache' | 'hosted-review' | null
  /** Link/suppression/provider context revision. */
  selectionRevision: string
}

/** Per-panel monotonically increasing counter scoped to the caller instance. */
export type PRDetailRecoveryClientEpoch = { scope: string; counter: number }

export type PRDetailRecoveryPhase =
  | 'waiting-existing'
  | 'queued'
  | 'paused'
  | 'preparing'
  | 'admitted'
  | 'terminal'

export type PRDetailRecoveryNotAdmittedReason =
  | 'validation'
  | 'host-off'
  | 'capacity'
  | 'epoch-conflict'
  | 'prepare-expired'
  | 'unregistered'

export type PRDetailRecoveryTerminal =
  | { kind: 'settled'; outcome: PRRefreshOutcome }
  | { kind: 'not-admitted'; reason: PRDetailRecoveryNotAdmittedReason }
  | { kind: 'cancelled' | 'expired' | 'superseded' | 'timeout' }

export type PRDetailRecoverySnapshot = {
  ticketId: string
  hostInstance: string
  identity: PRDetailRecoveryIdentity
  revision: number
  acceptSequence: number
  predecessors: { requestId: string; registrationOrder: number; identityDigest: string }[]
  preparation?: { token: string; expiresAt: number; prepareSequence: number }
  publicationGrantId?: string
  phase: PRDetailRecoveryPhase
  admitted: boolean
  notBefore?: number
  requestSequence?: number
  requestStartedAt?: number
  terminal?: PRDetailRecoveryTerminal
}

export type PRDetailRecoveryStartArgs = {
  clientEpoch: PRDetailRecoveryClientEpoch
  identity: PRDetailRecoveryIdentity
  /** The caller's PR cache alias; it matches later work for this alias, never authorization. */
  cacheKey: string
}
export type PRDetailRecoveryWaitArgs = { ticketId: string; afterRevision: number }
export type PRDetailRecoveryCommitArgs = {
  ticketId: string
  prepareToken: string
  publicationGrantId: string
}
export type PRDetailRecoveryCancelArgs = { ticketId: string }

export function prDetailRecoveryIdentityDigest(identity: PRDetailRecoveryIdentity): string {
  return JSON.stringify([
    identity.sourceEpoch,
    identity.repoId,
    identity.repoPath,
    identity.worktreeId,
    identity.branch,
    identity.currentHeadOid,
    identity.executionHostId,
    identity.provider,
    identity.linkedPRNumber,
    identity.linkedPRNumber == null ? identity.fallbackPRNumber : null,
    identity.linkedPRNumber == null ? identity.fallbackPRSource : null,
    identity.selectionRevision
  ])
}
