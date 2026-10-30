import type { AgentStatusEntry } from './agent-status-types'

/** Retain explicit status past this threshold so silent hook streams decay working dots back to active. */
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000

/** Hydrated nonterminal rows stay unverifiable throughout retention; missing exit evidence must not let the live window end them. */
export const AGENT_STATUS_HYDRATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Use the authority's evidence clock, comparable only on that machine; reconnect restamps updatedAt and must not extend freshness. */
export function agentStatusAuthorityObservedAt(
  entry: Pick<AgentStatusEntry, 'updatedAt' | 'evidenceObservedAt'>
): number {
  return entry.evidenceObservedAt ?? entry.updatedAt
}

/** Measure mirrored age by replica-local receipt, never host stamps minus local now. Local observations use this machine's authority clock; see the decay rule in agent-status-observation.ts. */
export function agentStatusEvidenceObservedAt(
  entry: Pick<AgentStatusEntry, 'updatedAt' | 'evidenceObservedAt' | 'mirroredEvidenceReceivedAt'>
): number {
  return entry.mirroredEvidenceReceivedAt ?? agentStatusAuthorityObservedAt(entry)
}

type MirroredEvidenceClocks = Pick<
  AgentStatusEntry,
  'updatedAt' | 'evidenceObservedAt' | 'mirroredEvidenceReceivedAt'
>

/** Stamp local receipt to avoid host-clock skew. Carry the first locally stamped receipt for repeated observations so snapshots cannot extend quiet-pane freshness; never trust another machine's receipt stamp. */
export function withMirroredEvidenceReceipt<T extends MirroredEvidenceClocks>(
  entry: T,
  existing: MirroredEvidenceClocks | undefined,
  now: number
): T {
  const receivedAt =
    existing?.mirroredEvidenceReceivedAt !== undefined &&
    agentStatusAuthorityObservedAt(existing) === agentStatusAuthorityObservedAt(entry)
      ? existing.mirroredEvidenceReceivedAt
      : now
  return { ...entry, mirroredEvidenceReceivedAt: receivedAt }
}

export function isFreshNonDoneAgentStatus(
  entry:
    | Pick<
        AgentStatusEntry,
        | 'state'
        | 'updatedAt'
        | 'evidenceObservedAt'
        | 'mirroredEvidenceReceivedAt'
        | 'restoredUnconfirmed'
        | 'structuredHostOwned'
      >
    | undefined,
  now = Date.now(),
  staleAfterMs = AGENT_STATUS_STALE_AFTER_MS
): boolean {
  // Why: an unconfirmed hydrated row may describe a turn that ended while no receiver was up; never fresh.
  return Boolean(entry && entry.state !== 'done' && isAgentStatusFresh(entry, now, staleAfterMs))
}

/** Child evidence can remain live beneath a parent whose own turn is already done. */
export function isAgentStatusFresh(
  entry: Pick<
    AgentStatusEntry,
    | 'updatedAt'
    | 'evidenceObservedAt'
    | 'mirroredEvidenceReceivedAt'
    | 'restoredUnconfirmed'
    | 'structuredHostOwned'
  >,
  now = Date.now(),
  staleAfterMs = AGENT_STATUS_STALE_AFTER_MS
): boolean {
  return (
    entry.restoredUnconfirmed !== true &&
    (entry.structuredHostOwned === true ||
      now - agentStatusEvidenceObservedAt(entry) <= staleAfterMs)
  )
}
