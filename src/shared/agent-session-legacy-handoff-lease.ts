/**
 * Lease values only the removed terminal handoff wrote.
 *
 * Records an older build persisted can still carry a terminal owner (`runtimeKind: 'tui'`) or a
 * handoff stage (`preparing`, `old-owner-stopped`). They are accepted on disk and mapped here, once,
 * at decode, so no in-memory lease holds a value nothing in this build produces.
 */

import type {
  AgentSessionHandoffStage,
  AgentSessionLease,
  AgentSessionOwnerRuntimeKind,
  AgentSessionRecord
} from './agent-session-record'

type LegacyHandoffRuntimeKind = 'tui'
type LegacyHandoffStage = 'preparing' | 'old-owner-stopped'

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

export function leaseCarriesLegacyHandoffValues(lease: PersistedAgentSessionLease): boolean {
  return (
    lease.runtimeKind === 'tui' ||
    lease.handoffStage === 'preparing' ||
    lease.handoffStage === 'old-owner-stopped'
  )
}

/** Identity for every lease this build writes. */
export function normalizeLegacyHandoffLease(lease: PersistedAgentSessionLease): AgentSessionLease {
  const { runtimeKind, handoffStage } = lease
  const stage =
    handoffStage === 'preparing' || handoffStage === 'old-owner-stopped'
      ? 'recovering'
      : handoffStage
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
