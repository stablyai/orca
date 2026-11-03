import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { moveFloatingWorkspaceTab } from './floating-workspace-tab-reorder'

const mirrorWebRuntimeTabMoveMock = vi.hoisted(() => vi.fn())

vi.mock('../components/tab-bar/web-runtime-tab-move-mirror', () => ({
  mirrorWebRuntimeTabMove: mirrorWebRuntimeTabMoveMock
}))

function makeTab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeUnifiedTerminalTab(id: string, groupId = 'floating-group'): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('moveFloatingWorkspaceTab', () => {
  beforeEach(() => {
    mirrorWebRuntimeTabMoveMock.mockReset()
  })

  it('reorders the active tab within the floating group and mirrors the move', () => {
    const reorderUnifiedTabs = vi.fn()
    const store: Parameters<typeof moveFloatingWorkspaceTab>[0] = {
      activeGroupIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-group' },
      browserTabsByWorktree: {},
      groupsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: 'floating-group',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            activeTabId: 'tab-2',
            tabOrder: ['tab-1', 'tab-2', 'tab-3']
          }
        ]
      },
      openFiles: [],
      reorderUnifiedTabs,
      tabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [makeTab('tab-1'), makeTab('tab-2'), makeTab('tab-3')]
      },
      unifiedTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          makeUnifiedTerminalTab('tab-1'),
          makeUnifiedTerminalTab('tab-2'),
          makeUnifiedTerminalTab('tab-3')
        ]
      }
    }

    expect(moveFloatingWorkspaceTab(store, -1)).toBe(true)
    expect(reorderUnifiedTabs).toHaveBeenCalledWith('floating-group', ['tab-2', 'tab-1', 'tab-3'])
    expect(mirrorWebRuntimeTabMoveMock).toHaveBeenCalledWith({
      kind: 'reorder',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      tabId: 'tab-2',
      targetGroupId: 'floating-group',
      tabOrder: ['tab-2', 'tab-1', 'tab-3']
    })
  })
})
