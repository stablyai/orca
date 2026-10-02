/**
 * What a session's lease IS, derived from the stored record and what the execution host can prove
 * about its owner right now.
 *
 * The stored lease is the durable record a restart, a recovery or a second process reasons from; it
 * is never, on its own, the answer to "is anyone holding this". A release whose write failed leaves
 * a stored `live` behind a process the host watched exit, and a reader that trusted it refused every
 * later send. Every reader of lease state goes through this derivation instead, so the same proof
 * that lets an acquisition win also lets the send that wants it begin.
 *
 * Polarity is the adjudication's: nothing short of proof makes a recorded owner `free`. A conflicted
 * claim, a proven-alive owner, a reservation nothing proves unused and an owner the host cannot
 * probe — including one on another host, where lost contact is never evidence of death — all stay
 * held or unverifiable.
 */

import {
  deathEvidenceFor,
  isProvenAliveProbe,
  isProvenDeadProbe,
  type AgentSessionOwnerProbe
} from './agent-session-lease-adjudication'
import {
  failedAcquisitionDeathEvidence,
  failedAcquisitionReleasesReservation,
  isFailedAcquisitionReservation,
  type AgentSessionAcquisitionExitProof
} from './agent-session-failed-acquisition'
import type { AgentSessionDeathEvidence, AgentSessionLease } from './agent-session-record'
import type { AgentSessionOwnerVerdict } from './agent-session-wire-refusals'

/** What the host knows about the owner at one fence. Memory first: its own child, the exit of
 *  that child it watched, or how its own failed attempt accounted for its process. A probe only
 *  when memory has nothing to say. */
export type AgentSessionOwnerEvidence =
  | { kind: 'runs' }
  | { kind: 'watched-exit'; observedAt: number; reason: string | null }
  /** This host's attempt that reserved the fence failed, and its settlement write did not land. */
  | {
      kind: 'failed-acquisition'
      spawnToken: string
      operationId: string
      exitProof: AgentSessionAcquisitionExitProof
      observedAt: number
    }
  | { kind: 'probed'; probe: AgentSessionOwnerProbe }
  | { kind: 'none' }

export type AgentSessionHostProof = {
  /** The fence `owner` speaks for; a lease at any other fence learns nothing from it. */
  fence: number
  /** An acquisition of this host's is running for the session now. */
  attemptInFlight: boolean
  owner: AgentSessionOwnerEvidence
}

export type AgentSessionFreeBasis =
  /** Stored released, with whatever evidence its release wrote. */
  | { kind: 'stored' }
  | Extract<AgentSessionOwnerEvidence, { kind: 'watched-exit' | 'failed-acquisition' | 'probed' }>

export type AgentSessionLeaseState =
  | { state: 'reconciling' }
  | { state: 'conflicted' }
  | { state: 'recovering' }
  /** This host is acquiring it: a spawn is under way, or has just proven itself. */
  | { state: 'acquiring' }
  | { state: 'held'; by: 'this-host' | 'proven-alive' }
  /** A recorded owner or reservation nothing proves either way. */
  | { state: 'unverifiable' }
  | { state: 'free'; basis: AgentSessionFreeBasis }

/** Detail a release on a watched exit records when the exit itself gave no reason. */
export const SURFACE_RELEASE_EXIT_DETAIL = 'the last surface holding this session released it'

export function deriveAgentSessionLeaseState(
  lease: AgentSessionLease,
  proof: AgentSessionHostProof | null
): AgentSessionLeaseState {
  // Why: the only stored release restart adjudication calls free, so reconciling it changes nothing.
  const storedRelease =
    lease.claimStatus === 'released' &&
    lease.handoffStage === null &&
    lease.ownerProcess === null &&
    lease.reservedSpawnToken === null
  if (lease.unreconciled && !storedRelease) {
    return { state: 'reconciling' }
  }
  if (lease.claimStatus === 'conflicted') {
    return { state: 'conflicted' }
  }
  if (lease.handoffStage === 'recovering') {
    return { state: 'recovering' }
  }
  if (proof?.attemptInFlight) {
    return { state: 'acquiring' }
  }
  if (storedRelease) {
    return { state: 'free', basis: { kind: 'stored' } }
  }
  const owner: AgentSessionOwnerEvidence =
    proof && proof.fence === lease.runtimeFence ? proof.owner : { kind: 'none' }
  if (owner.kind === 'failed-acquisition') {
    // Why: exactly the lease its settlement would have left: released, or parked in recovery.
    if (!isFailedAcquisitionReservation(lease, owner)) {
      return { state: 'unverifiable' }
    }
    return failedAcquisitionReleasesReservation(lease, owner.exitProof)
      ? { state: 'free', basis: owner }
      : { state: 'recovering' }
  }
  if (lease.ownerProcess === null) {
    // Why: the spawn token is the only thing an unrecorded child could carry; only a scan that
    // proves no process has it frees the reservation.
    return owner.kind === 'probed' && owner.probe.outcome === 'reservation-unused'
      ? { state: 'free', basis: owner }
      : { state: 'unverifiable' }
  }
  switch (owner.kind) {
    case 'runs':
      return {
        state: 'held',
        by:
          lease.claimStatus === 'live' && lease.handoffStage === null ? 'this-host' : 'proven-alive'
      }
    case 'watched-exit':
      return { state: 'free', basis: owner }
    case 'probed':
      if (isProvenDeadProbe(owner.probe)) {
        return { state: 'free', basis: owner }
      }
      return isProvenAliveProbe(owner.probe)
        ? { state: 'held', by: 'proven-alive' }
        : { state: 'unverifiable' }
    case 'none':
      return { state: 'unverifiable' }
  }
}

/** The verdict clients see: `exited` only on proof, `live` for a held or acquiring owner. */
export function agentSessionLeaseOwnerVerdict(
  lease: AgentSessionLease,
  state: AgentSessionLeaseState
): AgentSessionOwnerVerdict {
  if (state.state === 'held' || state.state === 'acquiring') {
    return 'live'
  }
  if (state.state !== 'free') {
    return 'unverifiable'
  }
  // A release made without proof — recovery's, or a failed start's unproven cleanup — wrote no
  // evidence: its owner may still be running.
  const proved =
    state.basis.kind === 'stored'
      ? lease.deathEvidence !== null
      : state.basis.kind !== 'failed-acquisition' || state.basis.exitProof !== 'unproven'
  return proved ? 'exited' : 'unverifiable'
}

/** True only for the owner this host runs: every writer is this host's own child. */
export function agentSessionLeaseAdmitsWriter(state: AgentSessionLeaseState): boolean {
  return state.state === 'held' && state.by === 'this-host'
}

export function agentSessionLeaseIsFree(state: AgentSessionLeaseState): boolean {
  return state.state === 'free'
}

/** The proof of death a free lease stands on: the stored release's own evidence, or the evidence
 *  the derivation found, as the release that never landed would have written it. */
export function agentSessionLeaseFreeEvidence(
  lease: AgentSessionLease,
  basis: AgentSessionFreeBasis,
  now: number
): AgentSessionDeathEvidence | null {
  if (basis.kind === 'stored') {
    return lease.deathEvidence
  }
  if (basis.kind === 'watched-exit') {
    return {
      kind: 'exit-observed',
      detail: basis.reason ?? SURFACE_RELEASE_EXIT_DETAIL,
      observedAt: basis.observedAt,
      ownerFence: lease.runtimeFence
    }
  }
  if (basis.kind === 'failed-acquisition') {
    return failedAcquisitionDeathEvidence(basis.exitProof, basis.observedAt, lease.runtimeFence)
  }
  if (basis.probe.outcome === 'reservation-unused') {
    return {
      kind: 'pid-absent',
      detail: 'reservation never spawned',
      observedAt: now,
      ownerFence: lease.runtimeFence
    }
  }
  return deathEvidenceFor(basis.probe, now, lease)
}
