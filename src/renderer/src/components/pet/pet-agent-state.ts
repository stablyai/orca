import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'

export type PetAnimationName =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'review'
  | 'jumping'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'failed'

// Drag direction is a SHARED rule — the phone drags the same pet. Re-exported
// here so existing renderer imports keep working; the definition lives in
// shared/pet-drag.ts.
import type { PetDragAnimation } from '../../../../shared/pet-drag'
export type { PetDragAnimation }

// Why: mirrors hermes-agent's flashPetActivity(ms = 1600) — a completion/
// cancellation beat reads as "just happened" for this long before decaying
// back into the steady-state ladder below.
export const PET_BEAT_MS = 1600

// Why: Orca has no gateway-reported "error" state (AgentStatusEntry only
// carries working/blocked/waiting/done). We adapt hermes's error->failed beat
// to the closest Orca-native signal: a `done` state whose `interrupted` flag
// says the user cancelled the turn rather than the agent finishing it. A
// clean `done` fires the `waving` celebration beat instead.

export { nextPetDragAnimation } from '../../../../shared/pet-drag'

export type PetAnimationInput = {
  entries: AgentStatusEntry[]
  retainedCount: number
  dragging: boolean
  dragAnimation: PetDragAnimation
  hovering: boolean
  now: number
  staleAfterMs: number
}

// Why: `stateStartedAt` already records when the pane transitioned into its
// current state, so "is this beat still fresh" needs no extra timer/atom —
// it falls straight out of data already on the entry. This also gives us
// hermes's "sibling clearing" for free: because the whole ladder is
// re-derived from the live entry set on every call (nothing mutates a
// shared flag), a stale beat from one pane can never linger and outrank a
// fresh beat from another the way hermes's single mutable $petActivity
// object could without an explicit clear.
function isBeatFresh(entry: AgentStatusEntry, now: number): boolean {
  return now - entry.stateStartedAt < PET_BEAT_MS
}

function agentStateAnimation(
  entries: AgentStatusEntry[],
  retainedCount: number,
  now: number,
  staleAfterMs: number
): PetAnimationName {
  let hasWorking = false
  let hasDone = false
  let hasFailedBeat = false
  let hasWavingBeat = false

  for (const entry of entries) {
    if (!isExplicitAgentStatusFresh(entry, now, staleAfterMs)) {
      continue
    }
    if (entry.state === 'blocked' || entry.state === 'waiting') {
      // Why: a blocked/waiting agent means the USER is the bottleneck, so it
      // outranks everything else including an in-progress completion beat.
      return 'waiting'
    }
    if (entry.state === 'working') {
      hasWorking = true
    } else if (entry.state === 'done') {
      hasDone = true
      if (isBeatFresh(entry, now)) {
        if (entry.interrupted) {
          hasFailedBeat = true
        } else {
          hasWavingBeat = true
        }
      }
    }
  }

  if (hasFailedBeat) {
    return 'failed'
  }
  if (hasWavingBeat) {
    return 'waving'
  }
  if (hasWorking) {
    return 'running'
  }
  if (hasDone || retainedCount > 0) {
    return 'review'
  }
  return 'idle'
}

export function selectPetAnimationName({
  entries,
  retainedCount,
  dragging,
  dragAnimation,
  hovering,
  now,
  staleAfterMs
}: PetAnimationInput): PetAnimationName {
  const base = agentStateAnimation(entries, retainedCount, now, staleAfterMs)
  // Why: aligned with Codex. A horizontal drag runs toward the pointer,
  // grab-and-hold keeps the live agent state, and only a plain hover jumps.
  if (dragging) {
    return dragAnimation ?? base
  }
  if (hovering) {
    return 'jumping'
  }
  return base
}
