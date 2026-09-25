/**
 * Single-writer lease adjudication.
 *
 * Every decision here fails closed: expiry alone never grants a second owner, and an
 * unverifiable process counts as possibly alive until recovery resolution concludes about it. A
 * lease that names no process at all is released: nothing was recorded that could be holding it.
 * This is the opposite polarity
 * from daemon adoption checks, which fail open on a missing start time — a wrong answer there
 * refuses an adoption, a wrong answer here creates two writers on one provider session.
 */

import { nextAgentSessionFence } from './agent-session-next-fence'
import type {
  AgentSessionDeathEvidence,
  AgentSessionHandoffStage,
  AgentSessionLease
} from './agent-session-record'
import type { AgentSessionOwnerVerdict } from './agent-session-wire-refusals'

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
  /** The same acquisition operation re-entering its own reservation; no new fence, no new spawn. */
  | { decision: 'retry-reservation'; fence: number }
  | { decision: 'refused'; code: AgentSessionLeaseRefusalCode }

export type AgentSessionRestartAdjudication =
  /** Nothing is outstanding — no owner, no reservation. Clear any latched stage; the fence stays. */
  | { disposition: 'free'; reason: string }
  /** `evidence` is null when nothing proved the owner gone: it was never recorded. */
  | { disposition: 'evicted'; nextFence: number; evidence: AgentSessionDeathEvidence | null }
  | { disposition: 'recovering'; stage: AgentSessionHandoffStage; reason: string }

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

/** `exited` only for a lease released on death evidence; one recovery released without proof, like
 *  anything held or mid-handoff, may still be running. */
export function agentSessionLeaseOwnerVerdict(lease: AgentSessionLease): AgentSessionOwnerVerdict {
  if (agentSessionLeaseAdmitsWriter(lease)) {
    return 'live'
  }
  return lease.claimStatus === 'released' &&
    lease.handoffStage === null &&
    lease.ownerProcess === null &&
    lease.reservedSpawnToken === null &&
    lease.deathEvidence !== null
    ? 'exited'
    : 'unverifiable'
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
    // Why: the user's own terminal agent; restart adjudication and recovery retire it once gone.
    return { decision: 'refused', code: 'agent_session_conflict' }
  }
  if (lease.handoffStage === 'recovering') {
    // Why: no stage expires into an owner; recovery resolution concludes about it first.
    return { decision: 'refused', code: 'agent_session_ownership_unknown' }
  }
  if (lease.handoffStage !== null && lease.handoffOperationId !== null) {
    if (handoffOperationId !== lease.handoffOperationId) {
      // Why: the retry key is operation id + fence + stage; a different id is a different intent.
      return { decision: 'refused', code: 'agent_session_operation_conflict' }
    }
    if (
      lease.ownerProcess === null &&
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
  if (lease.ownerProcess === null) {
    if (lease.reservedSpawnToken === null && lease.claimStatus === 'released') {
      // Why: the spawn token is minted before the child and is the only thing a child could be
      // carrying. With no owner and no token nothing can hold this lease, so it is already free —
      // treating it as an unproven reservation is what re-latches every released record on restart.
      return { disposition: 'free', reason: 'lease has no owner and no reservation' }
    }
    // Why: a child spawned before its identity was recorded lost its stdio with the runtime that
    // crashed, so nothing can drive it. A token scan that proves no child is the only evidence there
    // can be; without it the lease is released anyway. A live child still carrying the token is
    // not signalled here, and the orphan reaper, which runs once at store open, may have seen this
    // lease still claiming it.
    return {
      disposition: 'evicted',
      nextFence: nextAgentSessionFence(lease),
      evidence:
        probe.outcome === 'reservation-unused'
          ? { kind: 'pid-absent', detail: 'reservation never spawned', observedAt }
          : null
    }
  }
  if (isProvenAliveProbe(probe)) {
    // Why: the surviving child's stdio died with the previous runtime, so readoption would renew
    // a lease no host can drive. Recovery stops the child and respawns at fence + 1.
    return {
      disposition: 'recovering',
      stage: 'recovering',
      reason: 'owner outlived the runtime that held its transport'
    }
  }
  const evidence = deathEvidenceFor(probe, observedAt)
  if (evidence) {
    return { disposition: 'evicted', nextFence: nextAgentSessionFence(lease), evidence }
  }
  return {
    // Why: recovery resolution, which runs next, owns the verdict on a recorded identity.
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
