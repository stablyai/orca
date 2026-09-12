import {
  agentStatusEvidenceObservedAt,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'

export {
  resolveAgentRowDisplayState,
  resolveDecayedAgentRowState,
  type AgentRowDisplayInput
} from '../../../shared/agent-status-row-display'
// Renderer-local alias kept so the sidebar's row type reads in its own vocabulary.
export type { AgentRowDisplayState as AgentRowState } from '../../../shared/agent-status-row-display'

/** Coarse `34m` / `2h` / `3d` duration, floored so it never overstates the gap. */
export function formatCompactDuration(deltaMs: number): string {
  const minutes = Math.max(0, Math.floor(deltaMs / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}

/**
 * The observer's report for an `unverifiable` row. Deliberately says what Orca last heard
 * rather than what the agent is doing: the elapsed time is what lets a user apply knowledge
 * Orca does not have (a 40-minute build, a long download).
 */
export function agentNoUpdateLabel(
  entry: Pick<AgentStatusEntry, 'updatedAt' | 'evidenceObservedAt'>,
  now: number
): string {
  return `No update in ${formatCompactDuration(now - agentStatusEvidenceObservedAt(entry))}`
}
