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

// Advance horizontal hysteresis only after accepted travel so slow diagonal drags accumulate.
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
    if (entry.state === 'working' && entry.workingMode !== 'monitoring') {
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
  // Horizontal drags run toward the pointer; stationary grabs retain live agent state, and plain hover jumps.
  if (dragging) {
    return dragAnimation ?? base
  }
  if (hovering) {
    return 'jumping'
  }
  return base
}
