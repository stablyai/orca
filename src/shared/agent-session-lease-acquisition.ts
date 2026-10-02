/**
 * Compare-and-swap acquisition: the derived lease state, plus the two things only an acquisition
 * asks about — whether the caller read the current fence, and whether it is re-entering its own
 * reservation. It runs inside the session's serialize, so no other attempt of this host's is in
 * flight beside it: a reservation another operation left behind belongs to an attempt that ended,
 * and is free once the host proves nothing was, or is still, spawned under it.
 */

import { isAgentSessionFenceCurrent } from './agent-session-lease-adjudication'
import type { AgentSessionOwnerProbe } from './agent-session-lease-adjudication'
import { deriveAgentSessionLeaseState } from './agent-session-lease-state'
import { nextAgentSessionFence } from './agent-session-next-fence'
import type { AgentSessionLease } from './agent-session-record'
import type { AgentSessionRefusalDetailsByCode } from './agent-session-wire-refusals'

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
  | {
      [C in AgentSessionLeaseRefusalCode]: {
        decision: 'refused'
        code: C
        details: AgentSessionRefusalDetailsByCode[C]
      }
    }[AgentSessionLeaseRefusalCode]

/** `probe` is what the host proved about the recorded owner at the lease's current fence. */
export function evaluateAgentSessionAcquisition(args: {
  lease: AgentSessionLease
  expectedFence: number
  handoffOperationId: string | null
  probe: AgentSessionOwnerProbe
}): AgentSessionAcquisitionDecision {
  const { lease, expectedFence, handoffOperationId, probe } = args
  const state = deriveAgentSessionLeaseState(lease, {
    fence: lease.runtimeFence,
    attemptInFlight: false,
    owner: { kind: 'probed', probe }
  })
  // Why: even a release the derivation calls free waits for its adjudication before a new fence.
  if (lease.unreconciled) {
    return {
      decision: 'refused',
      code: 'execution_owner_reconciling',
      details: { reason: 'hostReconciling' }
    }
  }
  if (!isAgentSessionFenceCurrent(lease, expectedFence)) {
    return {
      decision: 'refused',
      code: 'agent_session_checkpoint_stale',
      details: { reason: 'fenceStale' }
    }
  }
  if (state.state === 'conflicted') {
    // Why: the user's own terminal agent; restart adjudication and recovery retire it once gone.
    return {
      decision: 'refused',
      code: 'agent_session_conflict',
      details: { reason: 'claimConflicted' }
    }
  }
  if (state.state === 'recovering') {
    // Why: no stage expires into an owner; recovery resolution concludes about it first.
    return {
      decision: 'refused',
      code: 'agent_session_ownership_unknown',
      details: { reason: 'ownerUnproven' }
    }
  }
  if (lease.handoffStage !== null && lease.handoffOperationId !== null) {
    if (handoffOperationId === lease.handoffOperationId) {
      if (
        lease.ownerProcess === null &&
        lease.claimStatus === 'reserved' &&
        lease.reservedSpawnToken !== null
      ) {
        // Why: an idempotent re-run of a reservation that already exists at this fence.
        return { decision: 'retry-reservation', fence: lease.runtimeFence }
      }
    } else if (state.state !== 'free') {
      // Why: the retry key is operation id + fence + stage; a different id is a different intent.
      return {
        decision: 'refused',
        code: 'agent_session_operation_conflict',
        details: { reason: 'handoffInFlight' }
      }
    }
  }
  if (state.state === 'free') {
    return { decision: 'granted', nextFence: nextAgentSessionFence(lease) }
  }
  // Why: a lapsed deadline means Orca stopped hearing from the owner, not that the child stopped
  // editing files and spending tokens; a reservation with no proof may have lost the race with
  // its spawn rather than beaten it.
  return state.state === 'held'
    ? { decision: 'refused', code: 'agent_session_conflict', details: { reason: 'ownerAlive' } }
    : {
        decision: 'refused',
        code: 'agent_session_ownership_unknown',
        details: { reason: 'ownerUnproven' }
      }
}
