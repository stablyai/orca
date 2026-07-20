import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import { PET_BEAT_MS } from './pet-agent-state'

// Why: the bubble only speaks up for moods where knowing WHICH agent needs
// you is the point — the mundane steady states (idle/review) get the sprite
// pose but no bubble, matching the operator's "signal, not fidget" call.
export type PetBubbleMood = 'waiting' | 'failed' | 'waving' | 'running'

export type PetBubbleWinner = {
  mood: PetBubbleMood
  agentType: string | undefined
  /** Total number of fresh entries sharing the winning mood, including the
   *  attributed one. 1 means no count suffix is needed. */
  count: number
}

function isBeatFresh(entry: AgentStatusEntry, now: number): boolean {
  return now - entry.stateStartedAt < PET_BEAT_MS
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
  entries: AgentStatusEntry[],
  now: number,
  staleAfterMs: number
): PetBubbleWinner | null {
  const byMood: Record<PetBubbleMood, AgentStatusEntry[]> = {
    waiting: [],
    failed: [],
    waving: [],
    running: []
  }

  for (const entry of entries) {
    if (!isExplicitAgentStatusFresh(entry, now, staleAfterMs)) {
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
    return { mood, agentType: sorted[0].agentType, count: sorted.length }
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
