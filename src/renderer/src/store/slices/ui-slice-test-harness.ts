import { withSessionSourceTestWrites } from '@/lib/test-support/session-source-test-store'
import { createStore } from 'zustand/vanilla'
import { getDefaultUIState } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { AppState } from '../types'
import { createUISlice } from './ui'
import { createWorktreeNavHistorySlice } from './worktree-nav-history'
import { createSettingsSearchState } from './settings-search-state'

export function createUIStore() {
  // Only the UI slice, repo/worktree ids, and right sidebar width fallback are
  // needed for these tests. The worktree-nav-history slice is also included
  // because page opens record view visits.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture initializes only the UI slices under test.
  return createStore<AppState>()(
    withSessionSourceTestWrites(
      (...args) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture initializes only the UI slices under test.
        ({
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
          ...createWorktreeNavHistorySlice(...args),
          ...createUISlice(...args)
        }) as unknown as AppState
    )
  )
}

export function makePersistedUI(overrides: Partial<PersistedUIState> = {}): PersistedUIState {
  return {
    ...getDefaultUIState(),
    ...overrides
  }
}
