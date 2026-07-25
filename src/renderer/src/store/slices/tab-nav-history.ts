import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

// Why: bound per-worktree history growth; 50 matches the worktree-nav-history cap.
const MAX_HISTORY = 50

export type TabNavHistoryState = {
  // Linear history of unified tab ids, oldest -> newest.
  entries: string[]
  // Index into entries pointing at the active entry; -1 means empty.
  index: number
}

export type TabNavHistorySlice = {
  tabNavHistoryByWorktree: Record<string, TabNavHistoryState>
  // Why: true during goBack/goForward so recordTabVisit skips re-recording a history-driven activation.
  isNavigatingTabHistory: boolean

  recordTabVisit: (worktreeId: string, tabId: string) => void
  goBackTabHistory: (worktreeId: string) => void
  goForwardTabHistory: (worktreeId: string) => void
}

// Why: closed tabs stay in the stack (cheap) and are skipped during walks instead of pruned on every close.
function isLiveTabEntry(state: AppState, worktreeId: string, tabId: string): boolean {
  return (state.unifiedTabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
}

export function findPrevLiveTabHistoryIndex(state: AppState, worktreeId: string): number | null {
  const history = state.tabNavHistoryByWorktree[worktreeId]
  if (!history) {
    return null
  }
  for (let i = history.index - 1; i >= 0; i--) {
    if (isLiveTabEntry(state, worktreeId, history.entries[i])) {
      return i
    }
  }
  return null
}

export function findNextLiveTabHistoryIndex(state: AppState, worktreeId: string): number | null {
  const history = state.tabNavHistoryByWorktree[worktreeId]
  if (!history) {
    return null
  }
  for (let i = history.index + 1; i < history.entries.length; i++) {
    if (isLiveTabEntry(state, worktreeId, history.entries[i])) {
      return i
    }
  }
  return null
}

export function canGoBackTabHistory(state: AppState, worktreeId: string): boolean {
  return findPrevLiveTabHistoryIndex(state, worktreeId) !== null
}

export function canGoForwardTabHistory(state: AppState, worktreeId: string): boolean {
  return findNextLiveTabHistoryIndex(state, worktreeId) !== null
}

function appendTabHistoryEntry(history: TabNavHistoryState, tabId: string): TabNavHistoryState {
  // Why: de-dup only against the current entry so A -> B -> A stays a valid stack.
  if (history.entries[history.index] === tabId) {
    return history
  }

  // Truncate forward entries so appending starts a new branch.
  const entries = history.entries.slice(0, history.index + 1)
  entries.push(tabId)
  let index = history.index + 1

  // Why: shift index left by the eviction count so it still points at the just-appended entry.
  if (entries.length > MAX_HISTORY) {
    const evict = entries.length - MAX_HISTORY
    entries.splice(0, evict)
    index = Math.max(0, index - evict)
  }

  return { entries, index }
}

export const createTabNavHistorySlice: StateCreator<AppState, [], [], TabNavHistorySlice> = (
  set,
  get
) => ({
  tabNavHistoryByWorktree: {},
  isNavigatingTabHistory: false,

  recordTabVisit: (worktreeId, tabId) => {
    const state = get()
    if (state.isNavigatingTabHistory) {
      return
    }
    let history = state.tabNavHistoryByWorktree[worktreeId] ?? { entries: [], index: -1 }
    // Why: seed an empty stack with the tab being left so the first switch already has a Back target.
    if (history.entries.length === 0) {
      const currentTabId = state.getActiveTab(worktreeId)?.id
      if (currentTabId && currentTabId !== tabId) {
        history = { entries: [currentTabId], index: 0 }
      }
    }
    const next = appendTabHistoryEntry(history, tabId)
    if (next === state.tabNavHistoryByWorktree[worktreeId]) {
      return
    }
    set((s) => ({
      tabNavHistoryByWorktree: { ...s.tabNavHistoryByWorktree, [worktreeId]: next }
    }))
  },

  goBackTabHistory: (worktreeId) => {
    navigateTabHistory(get, set, worktreeId, 'back')
  },

  goForwardTabHistory: (worktreeId) => {
    navigateTabHistory(get, set, worktreeId, 'forward')
  }
})

function navigateTabHistory(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  worktreeId: string,
  direction: 'back' | 'forward'
): void {
  const state = get()
  const targetIndex =
    direction === 'back'
      ? findPrevLiveTabHistoryIndex(state, worktreeId)
      : findNextLiveTabHistoryIndex(state, worktreeId)
  if (targetIndex === null) {
    return
  }
  const history = state.tabNavHistoryByWorktree[worktreeId]!
  const targetTabId = history.entries[targetIndex]

  // Why: capture-and-restore (not force false) so re-entrant navigation doesn't clobber the flag.
  const prevNavigating = state.isNavigatingTabHistory
  set({ isNavigatingTabHistory: true } as Partial<AppState>)
  try {
    get().activateTab(targetTabId)
    set({
      tabNavHistoryByWorktree: {
        ...get().tabNavHistoryByWorktree,
        [worktreeId]: { ...history, index: targetIndex }
      }
    } as Partial<AppState>)
  } finally {
    set({ isNavigatingTabHistory: prevNavigating } as Partial<AppState>)
  }
}
