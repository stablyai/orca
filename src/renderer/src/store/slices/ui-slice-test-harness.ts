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
    markdownTocPanelWidth: 240,
    combinedDiffFileTreeWidth: 256,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
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
