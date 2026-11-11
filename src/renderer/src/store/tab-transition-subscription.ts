import type { AppState } from './types'
import { readTabMapChanges } from './keyed-record-change-reads'
import type { TabMapChanges } from './keyed-record-transitions'

type ObservedStore = {
  getState: () => AppState
  subscribe: (listener: (state: AppState, previous: AppState) => void) => () => void
}

export type TabTransition = {
  /** Current accepted state; under reentrant writes one callback may span several writes. */
  state: AppState
  tabs: TabMapChanges | null
  unifiedTabs: TabMapChanges | null
}

/** Tab-map deltas since this subscriber's last delivery, read from the store's current state. */
export function subscribeTabTransitions(
  store: ObservedStore,
  listener: (transition: TabTransition) => void
): () => void {
  let { tabsByWorktree, unifiedTabsByWorktree } = store.getState()
  return store.subscribe(() => {
    const state = store.getState()
    const tabs = readTabMapChanges(state.tabsByWorktree, tabsByWorktree)
    const unifiedTabs = readTabMapChanges(state.unifiedTabsByWorktree, unifiedTabsByWorktree)
    tabsByWorktree = state.tabsByWorktree
    unifiedTabsByWorktree = state.unifiedTabsByWorktree
    if (tabs || unifiedTabs) {
      listener({ state, tabs, unifiedTabs })
    }
  })
}
