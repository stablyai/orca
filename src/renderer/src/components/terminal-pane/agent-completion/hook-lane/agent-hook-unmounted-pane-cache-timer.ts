import { useAppStore } from '@/store'
import type { AgentCompletionStatusSnapshot } from '../agent-completion-coordinator-types'

// Why: a pane no window mounted (a remote pane never opened here) has no titles to watch, so its accepted hooks drive the timer.
export function applyUnmountedPaneCacheTimer(
  paneKey: string,
  payload: AgentCompletionStatusSnapshot
): void {
  const state = useAppStore.getState()
  if (payload.state === 'working') {
    if (state.cacheTimerByKey[paneKey] != null) {
      state.setCacheTimerStartedAt(paneKey, null)
    }
    return
  }
  // Why: a parked pane's title watcher may already have started this turn's countdown.
  if (
    payload.state === 'done' &&
    payload.agentType === 'claude' &&
    state.cacheTimerByKey[paneKey] == null &&
    (state.settings === null || state.settings.promptCacheTimerEnabled)
  ) {
    state.setCacheTimerStartedAt(paneKey, Date.now())
  }
}
