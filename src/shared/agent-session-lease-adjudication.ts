/**
 * Single-writer lease adjudication: the owner-probe vocabulary and restart reconciliation. What a
 * lease is now, and whether an acquisition wins it, derive from these in `agent-session-lease-state`.
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

export function deathEvidenceFor(
  probe: AgentSessionOwnerProbe,
  observedAt: number,
  lease: AgentSessionLease
): AgentSessionDeathEvidence | null {
  // Capped so a clock that stepped back across the restart still writes a valid interval.
  const interval = {
    observedAt,
    ownerFence: lease.runtimeFence,
    lastProvenAliveAt: Math.min(lease.lastRenewedAt, observedAt)
  }
  if (probe.outcome === 'exit-observed') {
    return { kind: 'exit-observed', detail: 'observed process exit', ...interval }
  }
  if (probe.outcome === 'pid-absent') {
    return { kind: 'pid-absent', detail: 'recorded pid absent on host', ...interval }
  }
  if (probe.outcome === 'identity-mismatch') {
    return { kind: 'identity-mismatch', detail: `mismatched ${probe.field}`, ...interval }
  }
  return null
}

export function isAgentSessionFenceCurrent(lease: AgentSessionLease, fence: number): boolean {
  return Number.isSafeInteger(fence) && fence === lease.runtimeFence
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
    // never signalled: the token is inherited by every descendant, so it cannot prove which one is
    // the provider child.
    return {
      disposition: 'evicted',
      nextFence: nextAgentSessionFence(lease),
      evidence:
        probe.outcome === 'reservation-unused'
          ? {
              kind: 'pid-absent',
              detail: 'reservation never spawned',
              observedAt,
              ownerFence: lease.runtimeFence
            }
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
  const evidence = deathEvidenceFor(probe, observedAt, lease)
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
