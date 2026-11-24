// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTabGroup, makeUnifiedTab } from './tab-group.test-fixture'
import { closeContentTabThroughLayoutOwner } from './content-tab-close-through-layout-owner'

const owner = vi.hoisted(() => ({ complete: () => {} }))
vi.mock('@/runtime/workspace-layout/commands/layout-apply-send', () => ({
  sendLayoutApply: (
    _state: unknown,
    _workspace: string,
    _command: unknown,
    hooks: { apply: (result: { closed: string[] }) => void }
  ) => {
    owner.complete = () => hooks.apply({ closed: ['closing'] })
    return true
  }
}))

it.each([null, 'worker'])(
  'rechecks folded MRU candidates when main commits a content close (preselected: %s)',
  (preselected) => {
    const closing = makeUnifiedTab({
      id: 'closing',
      worktreeId: 'wt',
      groupId: 'pane',
      contentType: 'simulator'
    })
    const ordinary = makeUnifiedTab({
      id: 'ordinary',
      worktreeId: 'wt',
      groupId: 'pane',
      contentType: 'simulator'
    })
    const worker = makeUnifiedTab({
      id: 'worker',
      worktreeId: 'wt',
      groupId: 'pane',
      workerTab: {
        origin: {
          runId: 'run',
          dispatchId: 'dispatch',
          taskId: 'task',
          workerLeafId: '00000000-0000-4000-8000-000000000001',
          parent: { kind: 'pane', paneKey: 'coordinator:leaf' },
          coordinator: { kind: 'pane', paneKey: 'coordinator:leaf' }
        }
      }
    })
    useAppStore.setState({
      activeWorktreeId: 'wt',
      activeGroupIdByWorktree: { wt: 'pane' },
      unifiedTabsByWorktree: { wt: [ordinary, worker, closing] },
      groupsByWorktree: {
        wt: [
          makeTabGroup({
            id: 'pane',
            worktreeId: 'wt',
            activeTabId: 'closing',
            tabOrder: ['ordinary', 'worker', 'closing'],
            recentTabIds: ['ordinary', 'worker', 'closing']
          })
        ]
      },
      workerTabsMode: 'open-when-clicked',
      workerTabStripChoiceByWorktree: { wt: { worker: 'kept' } },
      workerTabPeekByGroupId: {},
      workerTabFailOpenShown: {},
      terminalLayoutsByTabId: {}
    })
    expect(
      closeContentTabThroughLayoutOwner(useAppStore.getState, closing, {
        nextActiveTabId: preselected,
        closeHere: () => {}
      })
    ).toBe(true)
    useAppStore.setState({
      unifiedTabsByWorktree: { wt: [ordinary, worker] },
      workerTabStripChoiceByWorktree: { wt: { worker: 'hidden' } },
      groupsByWorktree: {
        wt: [
          makeTabGroup({
            id: 'pane',
            worktreeId: 'wt',
            activeTabId: null,
            tabOrder: ['ordinary', 'worker'],
            recentTabIds: ['ordinary', 'worker']
          })
        ]
      }
    })
    owner.complete()
    expect(useAppStore.getState().groupsByWorktree.wt?.[0]?.activeTabId).toBe('ordinary')
    expect(useAppStore.getState().workerTabPeekByGroupId.pane).toBeUndefined()
  }
)
