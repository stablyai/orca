/**
 * What a failed acquisition's settlement rewrites and records. The settlement write and the lease
 * derivation both read it from here, so the release a host derives from its own failed attempt is
 * exactly the one that attempt's settlement would have written.
 */

import type { AgentSessionDeathEvidence, AgentSessionLease } from './agent-session-record'

/**
 * How the failed attempt's provider process was accounted for.
 * - `exit-proven`: cleanup observed the whole tree gone.
 * - `root-exit-observed`: the owner root's exit was observed first-hand, so the
 *   identity this lease is keyed on is dead, but its descendants were not proven
 *   gone. Releases the lease and says exactly that, claiming nothing more.
 * - `processless`: the attempt failed before a process existed.
 * - `unproven`: nothing about the process was observed. A recorded owner goes to recovery, which
 *   concludes about it; a reservation that recorded none is released, since the adapter already
 *   closed the stdio of anything it spawned.
 */
export type AgentSessionAcquisitionExitProof =
  | 'exit-proven'
  | 'root-exit-observed'
  | 'processless'
  | 'unproven'

/** The reservation a failed attempt's settlement may rewrite: that attempt's own, still proving. */
export function isFailedAcquisitionReservation(
  lease: AgentSessionLease,
  attempt: { spawnToken: string; operationId: string }
): boolean {
  return (
    lease.claimStatus === 'reserved' &&
    lease.handoffStage === 'new-owner-proving' &&
    lease.reservedSpawnToken === attempt.spawnToken &&
    lease.handoffOperationId === attempt.operationId
  )
}

/** Whether the settlement releases the reservation. Only a recorded owner whose exit went unproven
 *  is kept, for recovery to conclude about. */
export function failedAcquisitionReleasesReservation(
  lease: AgentSessionLease,
  exitProof: AgentSessionAcquisitionExitProof
): boolean {
  return exitProof !== 'unproven' || lease.ownerProcess === null
}

/** Records only what was observed: never a tree claim the cleanup did not make, and nothing at all
 *  when nothing was. */
export function failedAcquisitionDeathEvidence(
  exitProof: AgentSessionAcquisitionExitProof,
  observedAt: number,
  ownerFence: number
): AgentSessionDeathEvidence | null {
  if (exitProof === 'unproven') {
    return null
  }
  const proof = { observedAt, ownerFence }
  if (exitProof === 'processless') {
    return { kind: 'pid-absent', detail: 'reservation failed before spawn', ...proof }
  }
  if (exitProof === 'root-exit-observed') {
    return {
      kind: 'exit-observed',
      detail: 'the provider process exited; its descendants were not proven gone',
      ...proof
    }
  }
  // Cleanup proved no child of this attempt remains; it may never have spawned.
  return {
    kind: 'exit-observed',
    detail: 'acquisition cleanup proved no provider child remains',
    ...proof
  }
}
