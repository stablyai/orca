import { vi } from 'vitest'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { AppState } from '@/store/types'
import type { TerminalPaneTabDetachStore } from './terminal-pane-tab-detach-steps'

export const WORKTREE_ID = 'repo-1::/worktree'
export const SOURCE_TAB_ID = 'tab-source'
export const TARGET_GROUP_ID = 'group-target'
export const LEAF_1 = '11111111-1111-4111-8111-111111111111'
export const LEAF_2 = '22222222-2222-4222-8222-222222222222'

function createTerminalTab(id: string, ptyId: string | null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: 'Terminal 2',
    defaultTitle: 'Terminal 2',
    customTitle: null,
    color: null,
    sortOrder: 1,
    createdAt: 1
  }
}

/** A store whose createTab appends the new tab to the target group, as the real slice does. */
export function createStore(layout: TerminalLayoutSnapshot): TerminalPaneTabDetachStore {
  const store: TerminalPaneTabDetachStore = {
    activeTabId: SOURCE_TAB_ID,
    closeTab: vi.fn(),
    createTab: vi.fn<AppState['createTab']>((_worktreeId, _targetGroupId, _shell, options) => {
      const tab = createTerminalTab('tab-detached', options?.initialPtyId ?? null)
      const group = store.groupsByWorktree[WORKTREE_ID]?.find(
        (candidate) => candidate.id === TARGET_GROUP_ID
      )
      if (group && !group.tabOrder.includes(tab.id)) {
        group.tabOrder = [...group.tabOrder, tab.id]
      }
      store.tabsByWorktree[WORKTREE_ID]?.push(tab)
      return tab
    }),
    groupsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TARGET_GROUP_ID,
          worktreeId: WORKTREE_ID,
          activeTabId: 'tab-existing-1',
          tabOrder: ['tab-existing-1', 'tab-existing-2'],
          recentTabIds: []
        }
      ]
    },
    reorderUnifiedTabs: vi.fn<AppState['reorderUnifiedTabs']>((groupId, tabIds) => {
      const group = store.groupsByWorktree[WORKTREE_ID]?.find((entry) => entry.id === groupId)
      if (group) {
        group.tabOrder = tabIds
      }
    }),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn(),
    setTabCustomTitle: vi.fn(),
    setTabLayout: vi.fn<AppState['setTabLayout']>((tabId, nextLayout) => {
      if (nextLayout) {
        store.terminalLayoutsByTabId[tabId] = nextLayout
      } else {
        delete store.terminalLayoutsByTabId[tabId]
      }
    }),
    syncPaneDetachPtyOwnership: vi.fn(),
    tabsByWorktree: { [WORKTREE_ID]: [createTerminalTab(SOURCE_TAB_ID, 'pty-left')] },
    terminalLayoutsByTabId: { [SOURCE_TAB_ID]: layout },
    unifiedTabsByWorktree: { [WORKTREE_ID]: [] }
  }
  return store
}
