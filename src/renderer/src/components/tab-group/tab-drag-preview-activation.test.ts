import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import {
  applyDragPreviewTab,
  captureTabDragActivationSnapshot,
  restoreTabDragActivationSnapshot,
  restoreSourceGroupActiveTabAfterCrossGroupDrop
} from './tab-drag-preview-activation'

const WT = 'wt-preview-restore'

describe('restoreTabDragActivationSnapshot', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeWorktreeId: WT,
      activeTabType: 'terminal',
      activeTabId: 'terminal-1',
      activeTabIdByWorktree: { [WT]: 'terminal-1' },
      activeTabTypeByWorktree: { [WT]: 'terminal' },
      groupsByWorktree: {
        [WT]: [
          {
            id: 'group-1',
            worktreeId: WT,
            activeTabId: 'tab-1',
            tabOrder: ['tab-1', 'tab-2']
          }
        ]
      },
      unifiedTabsByWorktree: {
        [WT]: [
          {
            id: 'tab-1',
            groupId: 'group-1',
            worktreeId: WT,
            contentType: 'terminal',
            entityId: 'terminal-1',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          } satisfies Tab,
          {
            id: 'tab-2',
            groupId: 'group-1',
            worktreeId: WT,
            contentType: 'browser',
            entityId: 'browser-1',
            label: 'Browser',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          } satisfies Tab
        ]
      },
      activeGroupIdByWorktree: { [WT]: 'group-1' }
    })
  })

  it('does not publish repeated preview and restore actions', () => {
    const snapshot = captureTabDragActivationSnapshot(WT)
    const subscriber = vi.fn()
    const unsubscribe = useAppStore.subscribe(subscriber)

    try {
      applyDragPreviewTab({
        worktreeId: WT,
        groupId: 'group-1',
        tabId: 'tab-1',
        activeGroupId: 'group-1'
      })
      restoreTabDragActivationSnapshot(WT, snapshot)
      restoreSourceGroupActiveTabAfterCrossGroupDrop({
        worktreeId: WT,
        snapshot,
        sourceGroupId: 'group-1',
        movedTabId: 'tab-2'
      })
      expect(subscriber).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('restores active-surface fields after a drag preview is cancelled', () => {
    const snapshot = captureTabDragActivationSnapshot(WT)

    applyDragPreviewTab({
      worktreeId: WT,
      groupId: 'group-1',
      tabId: 'tab-2',
      activeGroupId: 'group-1'
    })

    expect(useAppStore.getState().activeTabType).toBe('browser')
    expect(useAppStore.getState().activeBrowserTabId).toBe('browser-1')

    restoreTabDragActivationSnapshot(WT, snapshot)

    const state = useAppStore.getState()
    expect(state.groupsByWorktree[WT]?.[0]?.activeTabId).toBe('tab-1')
    expect(state.activeTabType).toBe('terminal')
    expect(state.activeTabId).toBe('terminal-1')
    expect(state.activeTabIdByWorktree[WT]).toBe('terminal-1')
  })
})
