import { createAgentStatusEpochSelector } from '@/lib/agent-status/evidence/agent-status-epoch-selector'
import { getAgentStatusEpochNow } from '@/lib/agent-status/evidence/agent-status-epoch-clock'
import type { AgentStatusProjection } from '@/store/slices/agent-status/projection/agent-status-projection'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isAgentStatusFresh
} from '../../../../shared/agent-status/contracts/agent-status-freshness'

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

function agentStateAnimation(
  entries: Iterable<AgentStatusEntry>,
  now: number,
  staleAfterMs: number
): PetAnimationName {
  let hasWorking = false
  let hasDone = false

  for (const entry of entries) {
    if (!isAgentStatusFresh(entry, now, staleAfterMs)) {
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
  if (hasDone) {
    return 'review'
  }
  return 'idle'
}

const petAgentAnimation = createAgentStatusEpochSelector(
  (state: AppState, _owner: AgentStatusProjection, _activityRevision: number) =>
    agentStateAnimation(
      state.agentStatusByPaneKey.values(),
      getAgentStatusEpochNow(state.agentStatusEpoch),
      AGENT_STATUS_STALE_AFTER_MS
    )
)

export function selectPetAgentAnimation(state: AppState): PetAnimationName {
  const statuses = state.agentStatusByPaneKey
  return petAgentAnimation(state, statuses.projection, statuses.activityRevision)
}
