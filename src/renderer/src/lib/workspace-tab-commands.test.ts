import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  mirrorWebRuntimeTabMove: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState }
}))

vi.mock('./floating-workspace-terminal-actions', () => ({
  isEmptyFloatingWorkspacePanelVisible: vi.fn(() => false),
  isFloatingWorkspacePanelFocused: vi.fn(() => false),
  switchFloatingWorkspaceTab: vi.fn()
}))

vi.mock('./floating-workspace-tab-reorder', () => ({
  moveFloatingWorkspaceTab: vi.fn()
}))

vi.mock('@/components/tab-bar/web-runtime-tab-move-mirror', () => ({
  mirrorWebRuntimeTabMove: mocks.mirrorWebRuntimeTabMove
}))

import { dispatchWorkspaceTabCommand } from './workspace-tab-commands'
import { isFloatingWorkspacePanelFocused } from './floating-workspace-terminal-actions'
import { moveFloatingWorkspaceTab } from './floating-workspace-tab-reorder'

const WORKTREE_ID = 'worktree-1'
const SOURCE_PAGE_ID = 'browser-page-1'
const BROWSER_WORKSPACE_ID = 'browser-workspace-1'

function browserTab(id: string, entityId: string, groupId: string, sortOrder: number): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType: 'browser',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  }
}

describe('browser-source tab commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const target = browserTab('tab-browser-target', BROWSER_WORKSPACE_ID, 'group-right', 0)
    const neighbor = browserTab('tab-browser-neighbor', 'browser-workspace-2', 'group-right', 1)
    const unrelated = browserTab('tab-unrelated', 'browser-workspace-left', 'group-left', 2)
    mocks.getState.mockReturnValue({
      activeWorktreeId: WORKTREE_ID,
      activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-left' },
      groupsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'group-left',
            worktreeId: WORKTREE_ID,
            activeTabId: unrelated.id,
            tabOrder: [unrelated.id]
          },
          {
            id: 'group-right',
            worktreeId: WORKTREE_ID,
            activeTabId: target.id,
            tabOrder: [target.id, neighbor.id]
          }
        ]
      },
      unifiedTabsByWorktree: { [WORKTREE_ID]: [unrelated, target, neighbor] },
      tabsByWorktree: { [WORKTREE_ID]: [] },
      openFiles: [],
      browserTabsByWorktree: {
        [WORKTREE_ID]: [
          { id: BROWSER_WORKSPACE_ID },
          { id: 'browser-workspace-2' },
          { id: 'browser-workspace-left' }
        ]
      },
      browserPagesByWorkspace: {
        [BROWSER_WORKSPACE_ID]: [{ id: SOURCE_PAGE_ID }],
        'browser-workspace-2': [],
        'browser-workspace-left': []
      },
      tabBarOrderByWorktree: {},
      reorderUnifiedTabs: vi.fn()
    })
  })

  it('reorders the guest-owned group when focus points at another split', () => {
    const state = mocks.getState()
    expect(
      dispatchWorkspaceTabCommand({
        type: 'move-active',
        direction: 1,
        target: { kind: 'browser-source', sourceId: SOURCE_PAGE_ID }
      })
    ).toBe(true)

    expect(state.reorderUnifiedTabs).toHaveBeenCalledWith('group-right', [
      'tab-browser-neighbor',
      'tab-browser-target'
    ])
    expect(mocks.mirrorWebRuntimeTabMove).toHaveBeenCalledWith({
      kind: 'reorder',
      worktreeId: WORKTREE_ID,
      tabId: 'tab-browser-target',
      targetGroupId: 'group-right',
      tabOrder: ['tab-browser-neighbor', 'tab-browser-target']
    })
  })

  it('honors an explicit browser target while the floating panel owns focus', () => {
    vi.mocked(isFloatingWorkspacePanelFocused).mockReturnValue(true)
    const state = mocks.getState()

    expect(
      dispatchWorkspaceTabCommand({
        type: 'move-active',
        direction: 1,
        target: { kind: 'browser-source', sourceId: SOURCE_PAGE_ID }
      })
    ).toBe(true)

    expect(state.reorderUnifiedTabs).toHaveBeenCalledWith('group-right', [
      'tab-browser-neighbor',
      'tab-browser-target'
    ])
    expect(moveFloatingWorkspaceTab).not.toHaveBeenCalled()
  })
})
