/** Decode legacy tui owners, preparing/old-owner-stopped handoffs and manual-recovery latches once at load so in-memory leases contain only current values. */

import type {
  AgentSessionHandoffStage,
  AgentSessionLease,
  AgentSessionOwnerRuntimeKind,
  AgentSessionRecord
} from './agent-session-record'
import type { PersistedAgentSessionProviderHandleLink } from './agent-session-provider-handle'

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

/** A record as a row stores it. Decode through `decodePersistedAgentSessionRecord`. */
export type PersistedAgentSessionRecord = Omit<
  AgentSessionRecord,
  'lease' | 'providerHandleChain' | 'sleptAt' | 'lastTurn'
> & {
  lease: PersistedAgentSessionLease
  sleptAt?: unknown
  lastTurn?: unknown
  providerHandleChain: PersistedAgentSessionProviderHandleLink[]
}

/** Checked stored facts before the independent next-grant floor has been validated. */
export type PersistedAgentSessionObservationLease = Omit<
  PersistedAgentSessionLease,
  'minimumNextFence'
> & {
  minimumNextFence?: unknown
}
export type PersistedAgentSessionObservationRecord = Omit<PersistedAgentSessionRecord, 'lease'> & {
  lease: PersistedAgentSessionObservationLease
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

export function leaseCarriesLegacyHandoffValues(
  lease: PersistedAgentSessionObservationLease
): boolean {
  return lease.runtimeKind === 'tui' || isLegacyHandoffStage(lease.handoffStage)
}

/** Identity for every lease this build writes. */
export function normalizeLegacyHandoffLease<L extends PersistedAgentSessionObservationLease>(
  lease: L
): Omit<L, 'runtimeKind' | 'handoffStage' | 'claimStatus'> &
  Pick<AgentSessionLease, 'runtimeKind' | 'handoffStage' | 'claimStatus'> {
  const { runtimeKind, handoffStage }: PersistedAgentSessionObservationLease = lease
  // Why: every one of these awaited proof about an owner, which is what `recovering` resolves.
  const stage = isLegacyHandoffStage(handoffStage) ? 'recovering' : handoffStage
  if (runtimeKind === 'native') {
    return { ...lease, runtimeKind, handoffStage: stage }
  }
  return {
    ...lease,
    runtimeKind: 'native',
    handoffStage: stage,
    // Legacy terminal owners are user foreground agents: keep them conflicted and probe-only; native restart recovery would stop them.
    claimStatus: lease.ownerProcess === null ? lease.claimStatus : 'conflicted'
  }
}

/** A `conflicted` claim is a terminal agent an older build recorded, and only its exit frees the chat. */
export function terminalOwnerRefusalMessage(lease: AgentSessionLease): string {
  // Why: without a start time the pid may since belong to an unrelated process.
  const owner = lease.ownerProcess
  const process = owner?.processStartTimeMs != null ? ` (process ${owner.pid})` : ''
  return `This chat is still open in a terminal agent${process}. Quit that agent to continue the chat here.`
}
