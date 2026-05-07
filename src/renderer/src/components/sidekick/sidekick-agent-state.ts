import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'

export type SidekickAnimationName = 'idle' | 'running' | 'waiting' | 'review' | 'failed' | 'jumping'

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
  let hasInterruptedDone = false

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
      hasInterruptedDone ||= entry.interrupted === true
    }
  }

  if (hasWorking) {
    return 'running'
  }
  if (hasInterruptedDone) {
    return 'failed'
  }
  if (hasDone || retainedCount > 0) {
    return 'review'
  }
  return 'idle'
}
