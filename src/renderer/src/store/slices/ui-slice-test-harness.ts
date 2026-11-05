import { createStore, type StoreApi } from 'zustand/vanilla'
import { getDefaultUIState } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { AppState } from '../types'
import { createUISlice } from './ui'
import { createWorktreeNavHistorySlice } from './worktree-nav-history'
import { createSettingsSearchState } from './settings-search-state'

export function createUIStore(): StoreApi<AppState> {
  // Only the UI slice, repo/worktree ids, and right sidebar width fallback are
  // needed for these tests. The worktree-nav-history slice is also included
  // because page opens record view visits.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    repos: [],
    worktreesByRepo: {},
    rightSidebarOpen: false,
    rightSidebarWidth: 280,
    markdownTocPanelWidth: 240,
    combinedDiffFileTreeWidth: 256,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    // Why: acknowledgeAgents clears the agent-completion marker the terminal slice owns.
    unreadAgentCompletionPanes: {},
    ...createSettingsSearchState(args[0]),
    ...createWorktreeNavHistorySlice(...(args as Parameters<typeof createWorktreeNavHistorySlice>)),
    ...createUISlice(...(args as Parameters<typeof createUISlice>))
  })) as unknown as StoreApi<AppState>
}

export function makePersistedUI(overrides: Partial<PersistedUIState> = {}): PersistedUIState {
  return {
    ...getDefaultUIState(),
    ...overrides
  }
}
