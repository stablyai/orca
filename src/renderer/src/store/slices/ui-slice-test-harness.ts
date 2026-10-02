import type { StoreApi } from 'zustand/vanilla'
import { getDefaultUIState } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { AppState } from '../types'
import { createTestStore } from './store-test-helpers'

export function createUIStore(): StoreApi<AppState> {
  const store = createTestStore()
  store.setState({
    repos: [],
    worktreesByRepo: {},
    rightSidebarOpen: false,
    rightSidebarWidth: 280,
    subagentSheetWidth: 760,
    markdownTocPanelWidth: 240,
    combinedDiffFileTreeWidth: 256,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    // Why: acknowledgeAgents clears the agent-completion marker the terminal slice owns.
    unreadAgentCompletionPanes: {}
  })
  return store
}

export function makePersistedUI(overrides: Partial<PersistedUIState> = {}): PersistedUIState {
  return {
    ...getDefaultUIState(),
    ...overrides
  }
}
