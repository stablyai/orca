/**
 * Lease values only older builds wrote.
 *
 * Records an older build persisted can still carry a terminal owner (`runtimeKind: 'tui'`), a
 * handoff stage (`preparing`, `old-owner-stopped`), or the removed ownerless-reservation latch
 * (`manual-recovery`). They are accepted on disk and mapped here, once, at decode, so no in-memory
 * lease holds a value nothing in this build produces.
 */

import type {
  AgentSessionHandoffStage,
  AgentSessionLease,
  AgentSessionOwnerRuntimeKind,
  AgentSessionRecord
} from './agent-session-record'

type LegacyHandoffRuntimeKind = 'tui'
type LegacyHandoffStage = 'preparing' | 'old-owner-stopped' | 'manual-recovery'

export type PersistedAgentSessionRuntimeKind =
  | AgentSessionOwnerRuntimeKind
  | LegacyHandoffRuntimeKind
export type PersistedAgentSessionHandoffStage = AgentSessionHandoffStage | LegacyHandoffStage

/** A lease as it may appear on disk. */
export type PersistedAgentSessionLease = Omit<AgentSessionLease, 'runtimeKind' | 'handoffStage'> & {
  runtimeKind: PersistedAgentSessionRuntimeKind
  handoffStage: PersistedAgentSessionHandoffStage | null
}

export type PersistedAgentSessionRecord = Omit<AgentSessionRecord, 'lease'> & {
  lease: PersistedAgentSessionLease
}

export function isPersistedAgentSessionRuntimeKind(
  value: unknown
): value is PersistedAgentSessionRuntimeKind {
  return value === 'native' || value === 'tui'
}

export function isPersistedAgentSessionHandoffStage(
  value: unknown
): value is PersistedAgentSessionHandoffStage {
  return (
    value === 'preparing' ||
    value === 'old-owner-stopped' ||
    value === 'new-owner-proving' ||
    value === 'recovering' ||
    value === 'manual-recovery'
  )
}

function isLegacyHandoffStage(
  stage: PersistedAgentSessionHandoffStage | null
): stage is LegacyHandoffStage {
  return stage === 'preparing' || stage === 'old-owner-stopped' || stage === 'manual-recovery'
}

export function leaseCarriesLegacyHandoffValues(lease: PersistedAgentSessionLease): boolean {
  return lease.runtimeKind === 'tui' || isLegacyHandoffStage(lease.handoffStage)
}

/** Identity for every lease this build writes. */
export function normalizeLegacyHandoffLease(lease: PersistedAgentSessionLease): AgentSessionLease {
  const { runtimeKind, handoffStage } = lease
  // Why: every one of these awaited proof about an owner, which is what `recovering` resolves.
  const stage = isLegacyHandoffStage(handoffStage) ? 'recovering' : handoffStage
  if (runtimeKind === 'native') {
    return { ...lease, runtimeKind, handoffStage: stage }
  }
  return {
    ...lease,
    runtimeKind: 'native',
    handoffStage: stage,
    // Why: a recorded terminal is the user's foreground agent. `conflicted` is the claim every
    // build probes but never stops; a plain native owner would be stopped by restart recovery.
    claimStatus: lease.ownerProcess === null ? lease.claimStatus : 'conflicted'
  }
}

/** A `conflicted` claim is a terminal agent an older build recorded, and only its exit frees the chat. */
export function terminalOwnerRefusalMessage(lease: AgentSessionLease): string {
  const process = lease.ownerProcess ? ` (process ${lease.ownerProcess.pid})` : ''
  return `This chat is still open in a terminal agent${process}. Quit that agent to continue the chat here.`
}

/** The in-memory record, plus whether decode changed anything the store must write back. */
export function normalizeLegacyHandoffRecord(record: PersistedAgentSessionRecord): {
  record: AgentSessionRecord
  normalized: boolean
} {
  return {
    record: { ...record, lease: normalizeLegacyHandoffLease(record.lease) },
    normalized: leaseCarriesLegacyHandoffValues(record.lease)
  }
}
