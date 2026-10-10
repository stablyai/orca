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
  retainedAgentsByPaneKey: Record<string, { entry: AgentStatusEntry }>
  acknowledgedAgentsByPaneKey: Record<string, number>
  dragging: boolean
  dragAnimation: PetDragAnimation
  hovering: boolean
  now: number
  staleAfterMs: number
}

// Why: same read rule as the Activity badge and dashboard: an ack at or after the
// turn's start means the user has seen this completion, so it is not left to review.
function isAcknowledged(
  paneKey: string,
  entry: AgentStatusEntry,
  acknowledgedAgentsByPaneKey: Record<string, number>
): boolean {
  return (acknowledgedAgentsByPaneKey[paneKey] ?? 0) >= entry.stateStartedAt
}

function agentStateAnimation(
  entries: AgentStatusEntry[],
  retainedAgentsByPaneKey: Record<string, { entry: AgentStatusEntry }>,
  acknowledgedAgentsByPaneKey: Record<string, number>,
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
    } else if (
      entry.state === 'done' &&
      !isAcknowledged(entry.paneKey, entry, acknowledgedAgentsByPaneKey)
    ) {
      hasDone = true
    }
  }

  if (hasWorking) {
    return 'running'
  }
  const hasUnreadRetained = Object.entries(retainedAgentsByPaneKey).some(
    ([paneKey, retained]) => !isAcknowledged(paneKey, retained.entry, acknowledgedAgentsByPaneKey)
  )
  if (hasDone || hasUnreadRetained) {
    return 'review'
  }
  return 'idle'
}

export function selectPetAnimationName({
  entries,
  retainedAgentsByPaneKey,
  acknowledgedAgentsByPaneKey,
  dragging,
  dragAnimation,
  hovering,
  now,
  staleAfterMs
}: PetAnimationInput): PetAnimationName {
  const base = agentStateAnimation(
    entries,
    retainedAgentsByPaneKey,
    acknowledgedAgentsByPaneKey,
    now,
    staleAfterMs
  )
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
