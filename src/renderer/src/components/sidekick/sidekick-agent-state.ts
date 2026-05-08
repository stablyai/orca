import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'

export type SidekickAnimationName = 'idle' | 'running' | 'waiting' | 'review' | 'jumping'

export type SidekickAnimationInput = {
  entries: AgentStatusEntry[]
  retainedCount: number
  dragging: boolean
  now: number
  staleAfterMs: number
}

export function selectSidekickAnimationName({
  entries,
  retainedCount,
  dragging,
  now,
  staleAfterMs
}: SidekickAnimationInput): SidekickAnimationName {
  if (dragging) {
    return 'jumping'
  }

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
