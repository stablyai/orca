import { createAgentStatusEpochSelector } from '@/lib/agent-status/evidence/agent-status-epoch-selector'
import type { AppState } from '@/store/types'

import { freshActivityLiveAgentState } from './activity-event-state'

/** True while any live agent is blocked on a permission prompt or waiting for an answer. */
export function createAgentNeedsInputSelector(): (state: AppState) => boolean {
  return createAgentStatusEpochSelector((state: AppState) => {
    const now = Date.now()
    return Object.values(state.agentStatusByPaneKey).some((entry) => {
      const live = freshActivityLiveAgentState(entry, now)
      return live === 'blocked' || live === 'waiting'
    })
  })
}
