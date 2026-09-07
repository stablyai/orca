import type { AgentStatusEntry } from './agent-status-types'

/**
 * Freshness threshold for explicit agent status: retained past this so WorktreeCard's
 * sidebar dot can decay "working" back to "active" when the hook stream goes silent.
 */
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000

/** When the AUTHORITY says it observed the evidence, on the authority's own clock.
 *  A relay reconnect replays a cached row and must restamp `updatedAt`, so measuring against it
 *  pushes the deadline out by another window on every reconnect. Only comparable against a
 *  reading of that same clock — never against a replica's `now`. */
export function agentStatusAuthorityObservedAt(
  entry: Pick<AgentStatusEntry, 'updatedAt' | 'evidenceObservedAt'>
): number {
  return entry.evidenceObservedAt ?? entry.updatedAt
}

/** Age the staleness window measures, on the READER's clock.
 *  A row mirrored from another host carries the host's stamps, so subtracting them from this
 *  machine's `now` is off by the two clocks' skew in whichever direction the host runs. A
 *  mirrored row therefore carries this replica's own receipt time and decays against that;
 *  every locally observed row has none and falls through to the authority's clock, which is
 *  this machine's. See THE DECAY RULE in agent-status-observation.ts. */
export function agentStatusEvidenceObservedAt(
  entry: Pick<AgentStatusEntry, 'updatedAt' | 'evidenceObservedAt' | 'mirroredEvidenceReceivedAt'>
): number {
  return entry.mirroredEvidenceReceivedAt ?? agentStatusAuthorityObservedAt(entry)
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
      >
    | undefined,
  now = Date.now(),
  staleAfterMs = AGENT_STATUS_STALE_AFTER_MS
): boolean {
  // Why: an unconfirmed hydrated row may describe a turn that ended while no receiver was up; never fresh.
  return Boolean(
    entry &&
    entry.state !== 'done' &&
    entry.restoredUnconfirmed !== true &&
    now - agentStatusEvidenceObservedAt(entry) <= staleAfterMs
  )
}
