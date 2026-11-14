import {
  AGENT_STATUS_STALE_AFTER_MS,
  agentStatusEvidenceObservedAt,
  isAgentStatusFresh
} from '../contracts/agent-status-freshness'
import type { AgentStatusEntry, AgentStatusState } from '../contracts/agent-status-types'

/** Row states: the hook-reported statuses plus the two Orca derives when an entry goes stale. */
export type AgentRowState = AgentStatusState | 'idle' | 'unverifiable'

type DecayInput = Pick<AgentStatusEntry, 'state' | 'restoredUnconfirmed'>

/** Silence proves no completion: live-PTY rows become unverifiable, absent-PTY rows idle. Restored seeds predate this process and have no silence duration to report (ssh-execution-boundary.md). */
export function resolveDecayedAgentRowState(
  entry: DecayInput,
  hasLivePty: boolean
): 'idle' | 'unverifiable' {
  return hasLivePty && entry.state !== 'done' && entry.restoredUnconfirmed !== true
    ? 'unverifiable'
    : 'idle'
}

/** The row state the workspace card and Activity both show: stale working/blocked/waiting decays by PTY evidence. */
export function resolveAgentRowState(
  entry: DecayInput & Parameters<typeof isAgentStatusFresh>[0],
  now: number,
  hasLivePty: boolean
): AgentRowState {
  const canDecay =
    entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting'
  return canDecay && !isAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
    ? resolveDecayedAgentRowState(entry, hasLivePty)
    : entry.state
}

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

/** Report last-observed age rather than claiming current activity; the user may know a long-running task Orca cannot verify. */
export function agentNoUpdateLabel(
  entry: Pick<AgentStatusEntry, 'updatedAt' | 'evidenceObservedAt'>,
  now: number
): string {
  return `No update in ${formatCompactDuration(now - agentStatusEvidenceObservedAt(entry))}`
}
