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

export type PetDragAnimation = 'running-right' | 'running-left' | null

// Why: direction tracks horizontal travel only; `accepted` (advance the baseline)
// fires only on a >=4px horizontal move so slow diagonal drags still accumulate.
export function nextPetDragAnimation(
  current: PetDragAnimation,
  deltaX: number
): { animation: PetDragAnimation; accepted: boolean } {
  if (deltaX >= 4) {
    return { animation: 'running-right', accepted: true }
  }
  if (deltaX <= -4) {
    return { animation: 'running-left', accepted: true }
  }
  return { animation: current, accepted: false }
}

export type PetAnimationInput = {
  entries: AgentStatusEntry[]
  retainedCount: number
  dragging: boolean
  dragAnimation: PetDragAnimation
  hovering: boolean
  now: number
  staleAfterMs: number
}

function agentStateAnimation(
  entries: AgentStatusEntry[],
  retainedCount: number,
  now: number,
  staleAfterMs: number
): PetAnimationName {
  let hasWorking = false
  let hasDone = false

  for (const entry of entries) {
    if (!isExplicitAgentStatusFresh(entry, now, staleAfterMs)) {
      continue
    }
    if (entry.state === 'blocked' || entry.state === 'waiting') {
      return 'waiting'
    }
    if (entry.state === 'working') {
      hasWorking = true
    } else if (entry.state === 'done') {
      hasDone = true
    }
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
