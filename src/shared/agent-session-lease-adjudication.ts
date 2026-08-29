/**
 * Single-writer lease adjudication.
 *
 * Every decision here fails closed: expiry alone never grants a second owner, an unverifiable
 * process counts as possibly alive, and a stage that cannot prove an owner keeps re-asking —
 * or, when it names no process at all, ends in manual recovery — rather than handing the
 * session to the other runtime. This is the opposite polarity
 * from daemon adoption checks, which fail open on a missing start time — a wrong answer there
 * refuses an adoption, a wrong answer here creates two writers on one provider session.
 */

import { nextAgentSessionFence } from './agent-session-next-fence'
import type {
  AgentSessionDeathEvidence,
  AgentSessionHandoffStage,
  AgentSessionLease
} from './agent-session-record'

export type AgentSessionIdentityMatchField = 'process-start-time' | 'spawn-token'

export type AgentSessionOwnerProbe =
  /** Orca watched this exact process exit. */
  | { outcome: 'exit-observed' }
  /** The recorded pid is not present on the host. */
  | { outcome: 'pid-absent' }
  /** The pid is present but is a different process. */
  | { outcome: 'identity-mismatch'; field: AgentSessionIdentityMatchField | 'command-line' }
  /** The pid is present and at least one identity element was verified. */
  | { outcome: 'identity-matched'; matchedOn: readonly AgentSessionIdentityMatchField[] }
  /** No process carries the reserved spawn token and the provider saw no activity after it. */
  | { outcome: 'reservation-unused' }
  /** The host could not answer — restricted container, no start time, no token echo. */
  | { outcome: 'indeterminate'; reason: string }

export type AgentSessionLeaseRefusalCode =
  | 'agent_session_checkpoint_stale'
  | 'agent_session_conflict'
  | 'agent_session_ownership_unknown'
  | 'agent_session_operation_conflict'
  | 'execution_owner_reconciling'

export type AgentSessionAcquisitionDecision =
  | { decision: 'granted'; nextFence: number }
  /** The same handoff operation re-entering its own reservation; no new fence, no new spawn. */
  | { decision: 'retry-reservation'; fence: number }
  | { decision: 'refused'; code: AgentSessionLeaseRefusalCode }

export type AgentSessionRestartAdjudication =
  | { disposition: 'readopt' }
  /** Nothing is outstanding — no owner, no reservation. Clear any latched stage; the fence stays. */
  | { disposition: 'free'; reason: string }
  | { disposition: 'evicted'; nextFence: number; evidence: AgentSessionDeathEvidence }
  | { disposition: 'recovering'; stage: AgentSessionHandoffStage; reason: string }
  | { disposition: 'conflicted'; reason: string }

/** Stages that can legally admit a new owner at all; the rest have an owner or no evidence. */
const STAGES_ADMITTING_NEW_OWNER: ReadonlySet<AgentSessionHandoffStage> = new Set([
  'old-owner-stopped',
  'new-owner-proving'
])

export function isProvenDeadProbe(probe: AgentSessionOwnerProbe): boolean {
  return (
    probe.outcome === 'exit-observed' ||
    probe.outcome === 'pid-absent' ||
    probe.outcome === 'identity-mismatch'
  )
}

/**
 * A matched pid is only proof of life when something PID-reuse-safe matched with it. A bare pid
 * match on a host that can produce neither a start time nor a token echo is indeterminate.
 */
export function isProvenAliveProbe(probe: AgentSessionOwnerProbe): boolean {
  return probe.outcome === 'identity-matched' && probe.matchedOn.length > 0
}

function deathEvidenceFor(
  probe: AgentSessionOwnerProbe,
  observedAt: number
): AgentSessionDeathEvidence | null {
  if (probe.outcome === 'exit-observed') {
    return { kind: 'exit-observed', detail: 'observed process exit', observedAt }
  }
  if (probe.outcome === 'pid-absent') {
    return { kind: 'pid-absent', detail: 'recorded pid absent on host', observedAt }
  }
  if (probe.outcome === 'identity-mismatch') {
    return { kind: 'identity-mismatch', detail: `mismatched ${probe.field}`, observedAt }
  }
  return null
}

/** True when the recorded owner may write right now. Used by every mutating path in later parts. */
export function agentSessionLeaseAdmitsWriter(lease: AgentSessionLease): boolean {
  return (
    !lease.unreconciled &&
    lease.handoffStage === null &&
    lease.claimStatus === 'live' &&
    lease.ownerProcess !== null
  )
}

export function isAgentSessionFenceCurrent(lease: AgentSessionLease, fence: number): boolean {
  return Number.isSafeInteger(fence) && fence === lease.runtimeFence
}

/**
 * Compare-and-swap acquisition. `probe` describes what the host could prove about the recorded
 * owner; it is only consulted when a recorded owner or an unused reservation stands in the way.
 */
export function evaluateAgentSessionAcquisition(args: {
  lease: AgentSessionLease
  expectedFence: number
  handoffOperationId: string | null
  probe: AgentSessionOwnerProbe
}): AgentSessionAcquisitionDecision {
  const { lease, expectedFence, handoffOperationId, probe } = args
  if (lease.unreconciled) {
    return { decision: 'refused', code: 'execution_owner_reconciling' }
  }
  if (!isAgentSessionFenceCurrent(lease, expectedFence)) {
    return { decision: 'refused', code: 'agent_session_checkpoint_stale' }
  }
  if (lease.claimStatus === 'conflicted') {
    return { decision: 'refused', code: 'agent_session_conflict' }
  }
  if (lease.handoffStage === 'recovering' || lease.handoffStage === 'manual-recovery') {
    // Why: no stage expires into an owner; recovery is resolved by proof or by the user.
    return { decision: 'refused', code: 'agent_session_ownership_unknown' }
  }
  if (lease.handoffStage === 'preparing') {
    // Why: the old owner is quiesced but alive and still authoritative.
    return { decision: 'refused', code: 'agent_session_conflict' }
  }
  if (lease.handoffStage !== null && !STAGES_ADMITTING_NEW_OWNER.has(lease.handoffStage)) {
    return { decision: 'refused', code: 'agent_session_conflict' }
  }
  if (lease.handoffStage !== null && lease.handoffOperationId !== null) {
    if (handoffOperationId !== lease.handoffOperationId) {
      // Why: the retry key is operation id + fence + stage; a different id is a different intent.
      return { decision: 'refused', code: 'agent_session_operation_conflict' }
    }
    if (
      lease.ownerProcess === null &&
      STAGES_ADMITTING_NEW_OWNER.has(lease.handoffStage) &&
      lease.claimStatus === 'reserved' &&
      lease.reservedSpawnToken !== null
    ) {
      // Why: an idempotent re-run of a reservation that already exists at this fence.
      return { decision: 'retry-reservation', fence: lease.runtimeFence }
    }
  }
  if (lease.ownerProcess !== null) {
    if (!isProvenDeadProbe(probe)) {
      // Why: a lapsed deadline means Orca stopped hearing from the owner, not that the child
      // stopped editing files and spending tokens.
      return {
        decision: 'refused',
        code: isProvenAliveProbe(probe)
          ? 'agent_session_conflict'
          : 'agent_session_ownership_unknown'
      }
    }
    return { decision: 'granted', nextFence: nextAgentSessionFence(lease) }
  }
  if (lease.claimStatus === 'reserved' && probe.outcome !== 'reservation-unused') {
    // Why: a reservation with no proven process is not a free lease — the crash may have lost
    // the race with the spawn rather than beaten it.
    return { decision: 'refused', code: 'agent_session_ownership_unknown' }
  }
  return { decision: 'granted', nextFence: nextAgentSessionFence(lease) }
}

/**
 * Host-restart reconciliation for one persisted lease. Every lease is unreconciled at load and
 * grants no writer until this returns.
 */
export function adjudicateAgentSessionRestart(args: {
  lease: AgentSessionLease
  probe: AgentSessionOwnerProbe
  observedAt: number
}): AgentSessionRestartAdjudication {
  const { lease, probe, observedAt } = args
  if (lease.claimStatus === 'conflicted') {
    const conflictedOwnerDeath =
      lease.ownerProcess === null ? null : deathEvidenceFor(probe, observedAt)
    if (conflictedOwnerDeath) {
      // Why: the conflict names one specific process. Present-time proof that THAT process is gone
      // leaves no claimant to protect, and a conflict with no exit is a session the user can never
      // open again. Without such proof the conflict still outlives the process that observed it.
      return {
        disposition: 'evicted',
        nextFence: nextAgentSessionFence(lease),
        evidence: conflictedOwnerDeath
      }
    }
    return { disposition: 'conflicted', reason: 'claim conflicted before restart' }
  }
  if (lease.ownerProcess === null) {
    if (lease.reservedSpawnToken === null && lease.claimStatus !== 'reserved') {
      // Why: the spawn token is minted before the child and is the only thing a child could be
      // carrying. With no owner and no token nothing can hold this lease, so it is already free —
      // treating it as an unproven reservation is what re-latches every released record on restart.
      return { disposition: 'free', reason: 'lease has no owner and no reservation' }
    }
    if (probe.outcome === 'reservation-unused') {
      return {
        disposition: 'evicted',
        nextFence: nextAgentSessionFence(lease),
        evidence: { kind: 'pid-absent', detail: 'reservation never spawned', observedAt }
      }
    }
    return {
      disposition: 'recovering',
      stage: 'manual-recovery',
      reason: 'reservation with no proven process'
    }
  }
  if (isProvenAliveProbe(probe)) {
    if (lease.runtimeKind === 'native') {
      // Why: the surviving child's stdio died with the previous runtime, so readoption
      // would renew a lease no host can drive. Recovery stops it and respawns at fence + 1.
      return {
        disposition: 'recovering',
        stage: 'recovering',
        reason: 'native owner outlived the runtime that held its transport'
      }
    }
    // Why: re-adoption is not a new generation, so the fence does not move.
    return { disposition: 'readopt' }
  }
  const evidence = deathEvidenceFor(probe, observedAt)
  if (evidence) {
    return { disposition: 'evicted', nextFence: nextAgentSessionFence(lease), evidence }
  }
  return {
    // Why: an exact recorded identity can still be probed later, so the system keeps
    // re-asking; only a record naming nobody (above) needs the user to decide.
    disposition: 'recovering',
    stage: 'recovering',
    reason:
      probe.outcome === 'indeterminate' ? probe.reason : 'process identity could not be verified'
  }
}

/**
 * A process carrying an Orca spawn token with no matching lease is an orphan: stop it, never
 * adopt it. Neither age nor CPU is evidence — only a token match justifies acting on a process.
 */
export function classifyObservedAgentSessionSpawnToken(args: {
  spawnToken: string
  leases: readonly AgentSessionLease[]
}): 'owned' | 'orphan' {
  const owned = args.leases.some(
    (lease) =>
      lease.reservedSpawnToken === args.spawnToken ||
      lease.ownerProcess?.spawnToken === args.spawnToken
  )
  return owned ? 'owned' : 'orphan'
}
