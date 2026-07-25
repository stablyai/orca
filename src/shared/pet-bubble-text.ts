import { formatAgentTypeLabel } from './agent-type-label'
import type { AgentStatusState, AgentType } from './agent-status-types'

/**
 * What the pet says, and who it says it about.
 *
 * Shared rather than renderer-local for the reason edge geometry and drag
 * direction are (see pet-presence, pet-drag): the desktop and the phone are two
 * views of ONE creature. A pet that announces "codex is waiting" on one screen
 * and stays mute on the other is two pets wearing the same sprite.
 *
 * Pure: no React, no translate(), no store. The phrase bank stays per-surface
 * because it is localized copy, and each surface owns its own i18n — this module
 * decides WHICH mood and WHOSE, never the wording.
 */

// Why: the bubble only speaks up for moods where knowing WHICH agent needs you
// is the point — the mundane steady states (idle/review) get the sprite pose but
// no bubble, matching the operator's "signal, not fidget" call.
export type PetBubbleMood = 'waiting' | 'failed' | 'waving' | 'running'

export type PetBubbleWinner = {
  mood: PetBubbleMood
  agentType: string | undefined
  /** Total number of fresh entries sharing the winning mood, including the
   *  attributed one. 1 means no count suffix is needed. */
  count: number
  /** The pane this winner is attributed to — the same `sorted[0]` the mood and
   *  agentType come from. Exposed so a surface can ACT on the agent the pet is
   *  talking about (right-click → jump to it) without re-running the ladder and
   *  risking a different answer than the one on screen: attribution and action
   *  must agree, or the pet names one agent and takes you to another. */
  paneKey: string
}

/**
 * The minimum an agent row must carry to be bubble-worthy.
 *
 * Structural on purpose. The desktop passes `AgentStatusEntry` (from the pane
 * hook feed) and the phone passes `RuntimeWorktreeAgentRow` (from `worktree.ps`)
 * — two different transports for the same facts. Naming the fields instead of
 * the type is what lets one rule serve both without either surface converting.
 */
export type PetBubbleAgent = {
  state: AgentStatusState
  agentType?: AgentType | null
  paneKey: string
  stateStartedAt: number
  updatedAt: number
  interrupted?: boolean
}

/**
 * How long a completion/cancellation reads as "just happened" before decaying
 * back into the steady-state ladder. Mirrors hermes-agent's
 * flashPetActivity(ms = 1600).
 */
export const PET_BEAT_MS = 1600

/** A status entry is stale once nothing has updated it for staleAfterMs. Inlined
 *  here rather than imported from the renderer's pane-agent-evidence: that module
 *  reaches into terminal titles and TUI detection, none of which exists on the
 *  phone, and this is the whole of the rule. */
function isFresh(agent: PetBubbleAgent, now: number, staleAfterMs: number): boolean {
  return now - agent.updatedAt <= staleAfterMs
}

function isBeatFresh(agent: PetBubbleAgent, now: number): boolean {
  return now - agent.stateStartedAt < PET_BEAT_MS
}

/**
 * Pick the single highest-priority mood + agent to attribute the bubble to.
 *
 * Mirrors the priority ladder in `selectPetAnimationName` (waiting > failed >
 * waving > running) so the bubble text never disagrees with the sprite pose.
 * Deliberately does NOT rotate between agents sharing a mood — pins to one
 * (the earliest by paneKey, for determinism) and appends a `+N` count for the
 * rest, per the operator's "pin, don't rotate" call.
 */
export function selectPetBubbleWinner(
  entries: readonly PetBubbleAgent[],
  now: number,
  staleAfterMs: number
): PetBubbleWinner | null {
  const byMood: Record<PetBubbleMood, PetBubbleAgent[]> = {
    waiting: [],
    failed: [],
    waving: [],
    running: []
  }

  for (const entry of entries) {
    if (!isFresh(entry, now, staleAfterMs)) {
      continue
    }
    if (entry.state === 'blocked' || entry.state === 'waiting') {
      byMood.waiting.push(entry)
    } else if (entry.state === 'working') {
      byMood.running.push(entry)
    } else if (entry.state === 'done' && isBeatFresh(entry, now)) {
      if (entry.interrupted) {
        byMood.failed.push(entry)
      } else {
        byMood.waving.push(entry)
      }
    }
  }

  const priority: PetBubbleMood[] = ['waiting', 'failed', 'waving', 'running']
  for (const mood of priority) {
    const winners = byMood[mood]
    if (winners.length === 0) {
      continue
    }
    const sorted = [...winners].sort((a, b) => a.paneKey.localeCompare(b.paneKey))
    return {
      mood,
      agentType: sorted[0].agentType ?? undefined,
      count: sorted.length,
      paneKey: sorted[0].paneKey
    }
  }
  return null
}

// Random pick that avoids repeating the line already showing, ported from
// hermes-agent's pet-bubble `pick()`.
export function pickPetBubbleLine(lines: string[], prev: string): string {
  if (lines.length <= 1) {
    return lines[0] ?? ''
  }
  let next = prev
  while (next === prev) {
    next = lines[Math.floor(Math.random() * lines.length)]
  }
  return next
}

/** Compose the final bubble string: `<agent> <mood line><suffix>`. Kept as a
 *  pure function so text assembly (attribution + count) is unit-testable
 *  without pulling in translate()/React. */
export function formatPetBubbleText(
  winner: PetBubbleWinner,
  moodLine: string,
  countSuffix: (extra: number) => string
): string {
  const label = formatAgentTypeLabel(winner.agentType)
  const extra = winner.count - 1
  const suffix = extra > 0 ? ` ${countSuffix(extra)}` : ''
  return `${label} ${moodLine}${suffix}`
}

/**
 * Identity for "did the winner actually change" — mood + attributed agent +
 * count. A re-render with the same winner must not restart the hold timer or
 * re-pick a line; a genuinely new winner must do both. Shared so the two
 * surfaces cannot disagree about what counts as "the same thing being said".
 */
export function petBubbleWinnerKey(winner: PetBubbleWinner | null): string {
  if (!winner) {
    return ''
  }
  return `${winner.mood}:${winner.agentType ?? ''}:${winner.count}`
}
