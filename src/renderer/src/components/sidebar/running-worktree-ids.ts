import type { AppState } from '@/store'
import { tabHasLivePty } from '../../../../shared/tab-has-live-pty'

type RunningWorktreeState = Pick<AppState, 'tabsByWorktree' | 'ptyIdsByTabId'>

export function getRunningWorktreeIds(state: RunningWorktreeState): Set<string> {
  const ids = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some((tab) => tabHasLivePty(state.ptyIdsByTabId, tab.id))) {
      ids.add(worktreeId)
    }
  }
  return ids
}

/** A string key so subscribers re-render only when the running set changes, not on every PTY event. */
export function selectRunningWorktreeIdsKey(state: RunningWorktreeState): string {
  return [...getRunningWorktreeIds(state)].sort().join('\n')
}

export function parseRunningWorktreeIdsKey(key: string): Set<string> {
  return new Set(key ? key.split('\n') : [])
}
