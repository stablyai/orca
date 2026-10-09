import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))

import { getHiddenClusterTabIds, type TabGroup } from '../../../../../shared/tab-types'
import {
  createTestStore,
  makeOpenFile,
  makeTabGroup,
  makeUnifiedTab,
  seedStore,
  type TestStore
} from '../store-test-helpers'
import { createTabsSliceMockApi } from '../tabs-slice-test-harness'
import { handleSwitchRecentTab } from '@/hooks/ipc-tab-switch'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createTabsSliceMockApi()
const WT = 'repo1::/tmp/feature'
const PANE = 'pane'
const CLUSTER = 'cluster'

let store: TestStore

function pane(): TabGroup {
  return store.getState().groupsByWorktree[WT][0]
}

function seedPane(ids: string[] = ['a', 'b', 'x']): void {
  seedStore(store, {
    activeWorktreeId: WT,
    unifiedTabsByWorktree: {
      [WT]: ids.map((id, sortOrder) =>
        makeUnifiedTab({ id, worktreeId: WT, groupId: PANE, sortOrder, contentType: 'editor' })
      )
    },
    groupsByWorktree: {
      [WT]: [
        makeTabGroup({
          id: PANE,
          worktreeId: WT,
          tabOrder: ids,
          activeTabId: 'a',
          recentTabIds: ['a'],
          tabClusters: [
            { id: CLUSTER, name: 'Work', color: 'blue', collapsed: false, tabIds: ['a', 'b'] }
          ]
        })
      ]
    },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: PANE } },
    activeGroupIdByWorktree: { [WT]: PANE }
  })
}

describe('collapsed cluster sticky member', () => {
  beforeEach(() => {
    store = createTestStore()
    getStateMock.mockImplementation(() => store.getState())
  })

  it('captures the member on collapse and does not follow later activations', () => {
    seedPane()
    store.getState().setTabClusterCollapsed(PANE, CLUSTER, true)
    expect(pane().tabClusters?.[0].shownTabId).toBe('a')
    expect(pane().activeTabId).toBe('a')
    store.getState().activateTab('x')
    expect([...getHiddenClusterTabIds(pane())]).toEqual(['b'])
    store.getState().activateTab('b')
    expect([...getHiddenClusterTabIds(pane())]).toEqual([])
    store.getState().setTabClusterCollapsed(PANE, CLUSTER, true)
    expect(pane().tabClusters?.[0].shownTabId).toBe('a')
    store.getState().activateTab('x')
    expect([...getHiddenClusterTabIds(pane())]).toEqual(['b'])
    expect(pane().tabClusters?.[0].shownTabId).toBe('a')
  })

  it('does not capture any member when collapsing from an outside tab', () => {
    seedPane()
    store.getState().activateTab('x')
    store.getState().setTabClusterCollapsed(PANE, CLUSTER, true)
    expect(Object.hasOwn(pane().tabClusters?.[0] ?? {}, 'shownTabId')).toBe(false)
    expect([...getHiddenClusterTabIds(pane())]).toEqual(['a', 'b'])
    store.getState().activateTab('b')
    expect([...getHiddenClusterTabIds(pane())]).toEqual(['a'])
    store.getState().activateTab('x')
    expect([...getHiddenClusterTabIds(pane())]).toEqual(['a', 'b'])
    expect(pane().tabClusters?.[0].shownTabId).toBeUndefined()
  })

  it('clears the captured member on expansion before the next collapse', () => {
    seedPane()
    store.getState().setTabClusterCollapsed(PANE, CLUSTER, true)
    store.getState().setTabClusterCollapsed(PANE, CLUSTER, false)
    expect(Object.hasOwn(pane().tabClusters?.[0] ?? {}, 'shownTabId')).toBe(false)
    expect([...getHiddenClusterTabIds(pane())]).toEqual([])
    store.getState().activateTab('x')
    store.getState().setTabClusterCollapsed(PANE, CLUSTER, true)
    expect([...getHiddenClusterTabIds(pane())]).toEqual(['a', 'b'])
    expect(pane().tabClusters?.[0].shownTabId).toBeUndefined()
  })

  it('closing the inactive sticky member removes only it without revealing another member', () => {
    seedPane()
    store.getState().setTabClusterCollapsed(PANE, CLUSTER, true)
    store.getState().activateTab('x')
    store.getState().closeUnifiedTab('a')
    expect(pane().tabOrder).toEqual(['b', 'x'])
    expect(pane().activeTabId).toBe('x')
    expect(pane().tabClusters).toEqual([
      { id: CLUSTER, name: 'Work', color: 'blue', collapsed: true, tabIds: ['b'] }
    ])
    expect([...getHiddenClusterTabIds(pane())]).toEqual(['b'])
    expect(store.getState().unifiedTabsByWorktree[WT].map((tab) => tab.id)).toEqual(['b', 'x'])
  })

  it('closing the active sticky member prefers visible MRU tabs over more recent hidden members', () => {
    seedPane(['a', 'b', 'x', 'y'])
    store.getState().activateTab('y')
    store.getState().activateTab('x')
    store.getState().activateTab('b')
    store.getState().activateTab('a')
    store.getState().setTabClusterCollapsed(PANE, CLUSTER, true)
    store.getState().closeUnifiedTab('a')
    expect(pane().activeTabId).toBe('x')
    expect(pane().tabOrder).toEqual(['b', 'x', 'y'])
    expect([...getHiddenClusterTabIds(pane())]).toEqual(['b'])
    expect(pane().tabClusters?.[0].shownTabId).toBeUndefined()
  })

  it.each([
    { name: 'close', remove: () => store.getState().closeUnifiedTab('a') },
    {
      name: 'move',
      remove: (targetGroupId: string) => store.getState().moveUnifiedTabToGroup('a', targetGroupId)
    },
    {
      name: 'drop',
      remove: (targetGroupId: string) =>
        store.getState().dropUnifiedTab('a', { groupId: targetGroupId })
    }
  ])('$name records the visible successor for Ctrl+Tab', ({ remove }) => {
    const ids = ['a', 'b', 'c']
    seedPane(ids)
    store.setState({ openFiles: ids.map((id) => makeOpenFile({ id, worktreeId: WT })) })
    const targetGroupId = store
      .getState()
      .createEmptySplitGroup(WT, PANE, 'right', { activate: false })
    if (!targetGroupId) {
      throw new Error('Expected a target pane')
    }
    store.getState().activateTab('c')
    store.getState().activateTab('b')
    store.getState().activateTab('a')
    store.getState().setTabClusterCollapsed(PANE, CLUSTER, true)

    remove(targetGroupId)
    expect(pane().activeTabId).toBe('c')
    expect(pane().tabOrder).toEqual(['b', 'c'])
    expect(pane().recentTabIds).toEqual(['b', 'c'])
    expect([...getHiddenClusterTabIds(pane())]).toEqual(['b'])

    store.getState().focusGroup(WT, PANE)
    expect(handleSwitchRecentTab()).toBe(true)
    expect(pane().activeTabId).toBe('b')
  })

  it('closing the active sticky member skips hidden visual neighbors without prior MRU candidates', () => {
    seedPane()
    store.getState().setTabClusterCollapsed(PANE, CLUSTER, true)
    store.getState().closeUnifiedTab('a')
    expect(pane().activeTabId).toBe('x')
    expect([...getHiddenClusterTabIds(pane())]).toEqual(['b'])
  })

  it('falls back to a hidden member only when no visible successor exists', () => {
    seedPane(['a', 'b'])
    store.getState().setTabClusterCollapsed(PANE, CLUSTER, true)
    store.getState().closeUnifiedTab('a')
    expect(pane().activeTabId).toBe('b')
    expect(pane().tabOrder).toEqual(['b'])
    expect(pane().tabClusters).toEqual([
      { id: CLUSTER, name: 'Work', color: 'blue', collapsed: true, tabIds: ['b'] }
    ])
    expect([...getHiddenClusterTabIds(pane())]).toEqual([])
  })

  it('pinning the sticky member drops its membership and sticky state', () => {
    seedPane()
    store.getState().setTabClusterCollapsed(PANE, CLUSTER, true)
    store.getState().pinTab('a')
    expect(pane().tabClusters).toEqual([
      { id: CLUSTER, name: 'Work', color: 'blue', collapsed: true, tabIds: ['b'] }
    ])
    expect([...getHiddenClusterTabIds(pane())]).toEqual(['b'])
    expect(store.getState().unifiedTabsByWorktree[WT].find((tab) => tab.id === 'a')?.isPinned).toBe(
      true
    )
  })
})
