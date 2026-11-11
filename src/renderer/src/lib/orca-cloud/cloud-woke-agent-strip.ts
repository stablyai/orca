// The woke-up strip on an agent pane (JA-15 / RA-WAKE). The host relaunches the pane's agent after a
// wake by itself (WAKE-1, #450), usually within ~7 s, so a strip over it would sit on a live agent.
// Restart is only the fallback for a relaunch that never came (an older host, or a failed resume
// back at a bare shell).
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'

/** How long a woken pane may take to bring its agent back before Restart is offered. */
export const AGENT_RELAUNCH_GRACE_MS = 15_000
/**
 * How long after the wake a pane that showed something other than a shell may still fall back to
 * one (a relaunch that drew, then failed). Past it, the pane is the person's again: an agent they
 * quit later is not "stopped while asleep".
 */
export const AGENT_RELAUNCH_WATCH_MS = 60_000

/**
 * - `relaunched`: the agent is back (or the watch ended); the hint is done.
 * - `waiting`: within the grace; nothing shown.
 * - `watching`: past the grace, no word from the agent, and the screen is not a shell; nothing
 *   shown, the screen is checked again as it changes.
 * - `restart`: no word from the agent, and the pane sits at a bare shell.
 */
export type WokeAgentStripState = 'relaunched' | 'waiting' | 'watching' | 'restart'

/**
 * The agent's own evidence time (its hook events), never the delivery stamp: a reconnect replays
 * the pre-sleep row with a fresh `updatedAt`, which would read as a relaunch.
 */
export function agentEvidenceAt(entry: AgentStatusEntry | null | undefined): number | null {
  return entry?.evidenceObservedAt ?? null
}

export function wokeAgentStripState(input: {
  /** When the pane was looked at while asleep. */
  capturedAt: number
  /** The pane's agent evidence time now, or null. */
  evidenceAt: number | null
  /** Since the pane's workspace came back live. */
  sinceLiveMs: number
  /** Read only once the grace is over: the pane sits at a bare shell prompt. */
  paneAtShellPrompt: () => boolean
}): WokeAgentStripState {
  // The relaunched agent reported in (SessionStart): it is running; no strip.
  if (input.evidenceAt !== null && input.evidenceAt > input.capturedAt) {
    return 'relaunched'
  }
  if (input.sinceLiveMs < AGENT_RELAUNCH_GRACE_MS) {
    return 'waiting'
  }
  // No word from the agent: offer Restart only over a bare shell, never over a screen that may
  // be the relaunched agent itself.
  if (input.paneAtShellPrompt()) {
    return 'restart'
  }
  return input.sinceLiveMs < AGENT_RELAUNCH_WATCH_MS ? 'watching' : 'relaunched'
}
