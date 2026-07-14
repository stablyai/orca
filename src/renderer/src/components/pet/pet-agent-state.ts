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

// Why: aligned with the Codex drag sampler. Sub-4px moves are ignored so
// jitter can't flip direction, and vertical moves keep the last direction.
export function nextPetDragAnimation(
  current: PetDragAnimation,
  deltaX: number,
  deltaY: number
): { animation: PetDragAnimation; accepted: boolean } {
  if (Math.abs(deltaX) < 4 && Math.abs(deltaY) < 4) {
    return { animation: current, accepted: false }
  }
  return {
    animation: deltaX >= 4 ? 'running-right' : deltaX <= -4 ? 'running-left' : current,
    accepted: true
  }
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
