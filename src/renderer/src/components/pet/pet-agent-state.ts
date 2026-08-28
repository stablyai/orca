import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { PetAgentAnimation } from '../../../../shared/pet-types'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'

export type PetAnimationName = PetAgentAnimation | 'jumping' | 'running-right' | 'running-left'

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

export type PetAgentAnimationInput = {
  entries: AgentStatusEntry[]
  retainedCount: number
  now: number
  staleAfterMs: number
}

export type PetPointerAnimationInput = {
  dragging: boolean
  dragAnimation: PetDragAnimation
  hovering: boolean
}

export type PetAnimationInput = PetAgentAnimationInput & PetPointerAnimationInput

/** The agent-driven half of the pet's animation. Split out so the detached pet window can be
 *  handed this over IPC and still layer its own pointer states on top. */
export function selectPetAgentAnimation({
  entries,
  retainedCount,
  now,
  staleAfterMs
}: PetAgentAnimationInput): PetAgentAnimation {
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

// Why: aligned with Codex. A horizontal drag runs toward the pointer,
// grab-and-hold keeps the live agent state, and only a plain hover jumps.
export function applyPetPointerAnimation(
  base: PetAnimationName,
  { dragging, dragAnimation, hovering }: PetPointerAnimationInput
): PetAnimationName {
  if (dragging) {
    return dragAnimation ?? base
  }
  if (hovering) {
    return 'jumping'
  }
  return base
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
  return applyPetPointerAnimation(
    selectPetAgentAnimation({ entries, retainedCount, now, staleAfterMs }),
    { dragging, dragAnimation, hovering }
  )
}
