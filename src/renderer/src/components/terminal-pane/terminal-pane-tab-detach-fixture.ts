import { vi } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalPaneTabDetachStore } from './terminal-pane-tab-detach'

export const WORKTREE_ID = 'repo-1::/worktree'
export const SOURCE_TAB_ID = 'tab-source'
export const TARGET_GROUP_ID = 'group-target'
export const EXISTING_TAB_1 = 'tab-existing-1'
export const EXISTING_TAB_2 = 'tab-existing-2'
export const LEAF_1 = '11111111-1111-4111-8111-111111111111'
export const LEAF_2 = '22222222-2222-4222-8222-222222222222'

export function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_1 },
      second: { type: 'leaf', leafId: LEAF_2 }
    },
    activeLeafId: LEAF_2,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [LEAF_1]: 'pty-left',
      [LEAF_2]: 'remote:env-1@@terminal-1'
    },
    buffersByLeafId: {
      [LEAF_2]: 'remote-buffer'
    },
    titlesByLeafId: {
      [LEAF_2]: 'remote shell'
    }
  }
}

export function unboundSplitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_1 },
      second: { type: 'leaf', leafId: LEAF_2 }
    },
    activeLeafId: LEAF_2,
    expandedLeafId: null
  }
}

export function createTerminalTab(
  id: string,
  ptyId: string | null,
  shellOverride?: string
): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: 'Terminal 2',
    defaultTitle: 'Terminal 2',
    customTitle: null,
    color: null,
    sortOrder: 1,
    createdAt: 1,
    ...(shellOverride !== undefined ? { shellOverride } : {})
  }
}

export function createStore(
  layout: TerminalLayoutSnapshot = splitLayout(),
  targetTabOrder: string[] = [EXISTING_TAB_1, EXISTING_TAB_2],
  sourceShellOverride = 'powershell.exe'
): TerminalPaneTabDetachStore {
  const store = {
    closeTab: vi.fn(),
    createTab: vi.fn((_worktreeId, _targetGroupId, _shellOverride, options) => {
      const tab = createTerminalTab('tab-detached', options?.initialPtyId ?? null)
      const group = store.groupsByWorktree[WORKTREE_ID]?.find(
        (candidate) => candidate.id === TARGET_GROUP_ID
      )
      if (group && !group.tabOrder.includes(tab.id)) {
        group.tabOrder = [...group.tabOrder, tab.id]
      }
      return tab
    }),
    groupsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TARGET_GROUP_ID,
          worktreeId: WORKTREE_ID,
          activeTabId: targetTabOrder[0] ?? null,
          tabOrder: targetTabOrder,
          recentTabIds: []
        }
      ]
    },
    reorderUnifiedTabs: vi.fn((groupId: string, tabIds: string[]) => {
      const group = store.groupsByWorktree[WORKTREE_ID]?.find(
        (candidate) => candidate.id === groupId
      )
      if (group) {
        group.tabOrder = tabIds
      }
    }),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn(),
    setTabLayout: vi.fn((tabId: string, nextLayout: TerminalLayoutSnapshot | null) => {
      if (nextLayout) {
        store.terminalLayoutsByTabId[tabId] = nextLayout
      } else {
        delete store.terminalLayoutsByTabId[tabId]
      }
    }),
    syncPaneDetachPtyOwnership: vi.fn(),
    tabsByWorktree: {
      [WORKTREE_ID]: [createTerminalTab(SOURCE_TAB_ID, 'pty-left', sourceShellOverride)]
    },
    terminalLayoutsByTabId: {
      [SOURCE_TAB_ID]: layout
    }
  }
  return store as unknown as TerminalPaneTabDetachStore
}
