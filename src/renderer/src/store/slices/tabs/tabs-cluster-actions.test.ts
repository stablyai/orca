import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TAB_CLUSTER_COLORS, type TabCluster, type Tab } from '../../../../../shared/tab-types'
import {
  createTestStore,
  makeOpenFile,
  makeTabGroup,
  makeUnifiedTab,
  seedStore,
  type TestStore
} from '../store-test-helpers'
import { createTabsSliceMockApi } from '../tabs-slice-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createTabsSliceMockApi()
const WT = 'repo1::/tmp/feature'
const PANE = 'pane'

function cluster(id: string, tabIds: string[], overrides: Partial<TabCluster> = {}): TabCluster {
  return { id, name: '', color: 'blue', collapsed: false, tabIds, ...overrides }
}

describe('tab cluster actions', () => {
  let store: TestStore
  beforeEach(() => {
    store = createTestStore()
  })

  function seedPane(
    ids: string[],
    clusters?: TabCluster[],
    overrides: Record<string, Partial<Tab>> = {}
  ): void {
    seedStore(store, {
      unifiedTabsByWorktree: {
        [WT]: ids.map((id, sortOrder) =>
          makeUnifiedTab({
            id,
            worktreeId: WT,
            groupId: PANE,
            sortOrder,
            contentType: 'editor',
            ...overrides[id]
          })
        )
      },
      groupsByWorktree: {
        [WT]: [
          makeTabGroup({
            id: PANE,
            worktreeId: WT,
            tabOrder: ids,
            activeTabId: ids[0] ?? null,
            ...(clusters ? { tabClusters: clusters } : {})
          })
        ]
      },
      layoutByWorktree: { [WT]: { type: 'leaf', groupId: PANE } },
      activeGroupIdByWorktree: { [WT]: PANE }
    })
  }

  it('gathers eligible members in pane order at the first position and clears highlight selection', () => {
    seedPane(['pin', 'a', 'between', 'b', 'last'], undefined, { pin: { isPinned: true } })
    store.getState().setTabSelection(PANE, { tabIds: ['pin', 'a', 'b'], anchorTabId: 'a' })
    const id = store.getState().createTabCluster(PANE, ['b', 'foreign', 'pin', 'a', 'a'])
    expect(id).not.toBeNull()
    const pane = store.getState().groupsByWorktree[WT][0]
    expect(pane.tabOrder).toEqual(['pin', 'a', 'b', 'between', 'last'])
    expect(pane.tabClusters).toEqual([cluster(id!, ['a', 'b'], { color: 'grey' })])
    expect(pane.activeTabId).toBe('pin')
    expect(store.getState().tabSelectionByGroupId[PANE]).toBeUndefined()
    expect(
      store.getState().unifiedTabsByWorktree[WT].map((tab) => [tab.id, tab.sortOrder])
    ).toEqual([
      ['pin', 0],
      ['a', 1],
      ['between', 3],
      ['b', 2],
      ['last', 4]
    ])
  })

  it('does nothing for a pinned-only or foreign selection', () => {
    seedPane(['pin'], undefined, { pin: { isPinned: true } })
    const before = store.getState()
    expect(store.getState().createTabCluster(PANE, ['pin', 'missing'])).toBeNull()
    expect(store.getState()).toBe(before)
    expect(store.getState().createTabCluster('missing-pane', ['pin'])).toBeNull()
  })

  it('grouping preview editors promotes backing files and their tab instances to permanent', () => {
    seedPane(['preview', 'other'], undefined, {
      preview: { entityId: '/file.ts', isPreview: true }
    })
    store.setState({
      openFiles: [makeOpenFile({ id: '/file.ts', worktreeId: WT, isPreview: true })]
    })
    store.getState().createTabCluster(PANE, ['preview'])
    expect(store.getState().openFiles[0].isPreview).toBeUndefined()
    expect(store.getState().unifiedTabsByWorktree[WT][0].isPreview).toBe(false)
    store.getState().createUnifiedTab(WT, 'editor', { id: 'next-preview', isPreview: true })
    expect(store.getState().groupsByWorktree[WT][0].tabOrder).toContain('preview')
  })

  it.each([
    {
      selected: ['b', 'd'],
      order: ['a', 'c', 'b', 'd'],
      remaining: ['a', 'c']
    },
    {
      selected: ['a', 'd'],
      order: ['a', 'd', 'b', 'c'],
      remaining: ['b', 'c']
    }
  ])(
    'preserves untouched source members when regrouping $selected',
    ({ selected, order, remaining }) => {
      seedPane(['a', 'b', 'c', 'd'], [cluster('old', ['a', 'b', 'c'])])
      const id = store.getState().createTabCluster(PANE, selected)
      const pane = store.getState().groupsByWorktree[WT][0]
      expect(pane.tabOrder).toEqual(order)
      expect(pane.tabClusters).toEqual([
        cluster('old', remaining),
        cluster(id!, selected, { color: 'grey' })
      ])
    }
  )

  it('uses the first unused palette color and cycles after the palette is exhausted', () => {
    const ids = [...TAB_CLUSTER_COLORS.map((_, index) => `t${index}`), 'extra']
    seedPane(
      ids,
      TAB_CLUSTER_COLORS.map((color, index) => cluster(`c${index}`, [`t${index}`], { color }))
    )
    const id = store.getState().createTabCluster(PANE, ['extra'])
    expect(
      store.getState().groupsByWorktree[WT][0].tabClusters?.find((item) => item.id === id)?.color
    ).toBe('grey')
    store.getState().ungroupTabCluster(PANE, 'c3')
    store.getState().createUnifiedTab(WT, 'editor', { id: 'new' })
    const nextId = store.getState().createTabCluster(PANE, ['new'])
    expect(
      store.getState().groupsByWorktree[WT][0].tabClusters?.find((item) => item.id === nextId)
        ?.color
    ).toBe('yellow')
  })

  it('adds eligible tabs at the cluster end, taking members from other clusters', () => {
    seedPane(
      ['pin', 'a', 'b', 'outside', 'c', 'd'],
      [cluster('target', ['a', 'b'], { collapsed: true }), cluster('source', ['c', 'd'])],
      { pin: { isPinned: true } }
    )
    expect(
      store.getState().addTabsToCluster(PANE, 'target', ['d', 'pin', 'outside', 'missing'])
    ).toBe(true)
    const pane = store.getState().groupsByWorktree[WT][0]
    expect(pane.tabOrder).toEqual(['pin', 'a', 'b', 'outside', 'd', 'c'])
    expect(pane.tabClusters).toEqual([
      cluster('target', ['a', 'b', 'outside', 'd'], { collapsed: true }),
      cluster('source', ['c'])
    ])
    expect(store.getState().addTabsToCluster(PANE, 'missing-cluster', ['c'])).toBe(false)
    expect(store.getState().addTabsToCluster(PANE, 'target', ['pin', 'foreign'])).toBe(false)
  })

  it('adds preview editor tabs permanently and can rejoin a single reopened member', () => {
    seedPane(['a', 'preview'], [cluster('c', ['a'])], { preview: { isPreview: true } })
    store.setState({
      openFiles: [makeOpenFile({ id: 'preview', worktreeId: WT, isPreview: true })]
    })
    expect(store.getState().addTabsToCluster(PANE, 'c', ['preview'])).toBe(true)
    expect(store.getState().openFiles[0].isPreview).toBeUndefined()
    expect(store.getState().groupsByWorktree[WT][0].tabClusters?.[0].tabIds).toEqual([
      'a',
      'preview'
    ])
  })

  it('moves removed members just beyond their respective cluster ends', () => {
    seedPane(
      ['a', 'b', 'c', 'd', 'e', 'outside'],
      [cluster('one', ['a', 'b', 'c']), cluster('two', ['d', 'e'])]
    )
    store.getState().removeTabsFromCluster(PANE, ['a', 'c', 'd', 'outside', 'missing'])
    const pane = store.getState().groupsByWorktree[WT][0]
    expect(pane.tabOrder).toEqual(['b', 'a', 'c', 'e', 'd', 'outside'])
    expect(pane.tabClusters).toEqual([cluster('one', ['b']), cluster('two', ['e'])])
    store.getState().removeTabsFromCluster(PANE, ['b', 'e'])
    expect(Object.hasOwn(store.getState().groupsByWorktree[WT][0], 'tabClusters')).toBe(false)
  })

  it('trims and caps names, recolors, collapses without changing activation, and ungroups in place', () => {
    seedPane(['a', 'b', 'outside'], [cluster('c', ['a', 'b'])])
    store.getState().renameTabCluster(PANE, 'c', `  ${'x'.repeat(90)}  `)
    store.getState().setTabClusterColor(PANE, 'c', 'pink')
    store.getState().setTabClusterCollapsed(PANE, 'c', true)
    let pane = store.getState().groupsByWorktree[WT][0]
    expect(pane.tabClusters?.[0]).toEqual(
      cluster('c', ['a', 'b'], {
        name: 'x'.repeat(80),
        color: 'pink',
        collapsed: true,
        shownTabId: 'a'
      })
    )
    expect(pane.activeTabId).toBe('a')
    store.getState().activateTab('b')
    expect(store.getState().groupsByWorktree[WT][0].tabClusters?.[0].collapsed).toBe(true)
    store.getState().setTabClusterCollapsed(PANE, 'c', false)
    expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe('b')
    store.getState().ungroupTabCluster(PANE, 'c')
    pane = store.getState().groupsByWorktree[WT][0]
    expect(pane.tabOrder).toEqual(['a', 'b', 'outside'])
    expect(Object.hasOwn(pane, 'tabClusters')).toBe(false)
  })

  it('ignores edits to missing clusters and keeps state identity for unchanged cluster properties', () => {
    seedPane(['a'], [cluster('c', ['a'])])
    const before = store.getState()
    store.getState().renameTabCluster(PANE, 'c', '  ')
    store.getState().setTabClusterColor(PANE, 'c', 'blue')
    store.getState().setTabClusterCollapsed(PANE, 'c', false)
    store.getState().renameTabCluster(PANE, 'missing', 'Work')
    store.getState().ungroupTabCluster('missing-pane', 'c')
    expect(store.getState()).toBe(before)
  })

  it('uses post-removal strip indices and atomically moves tabs into and out of clusters', () => {
    seedPane(['a', 'b', 'outside', 'last'], [cluster('c', ['a', 'b'])])
    store.getState().moveTabsInStrip(PANE, ['last'], { index: 1, clusterId: 'c' })
    expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual(['a', 'last', 'b', 'outside'])
    expect(store.getState().groupsByWorktree[WT][0].tabClusters?.[0].tabIds).toEqual([
      'a',
      'last',
      'b'
    ])
    store.getState().moveTabsInStrip(PANE, ['a', 'last'], { index: 2, clusterId: null })
    expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual(['b', 'outside', 'a', 'last'])
    expect(store.getState().groupsByWorktree[WT][0].tabClusters?.[0].tabIds).toEqual(['b'])
    expect(
      store.getState().unifiedTabsByWorktree[WT].map((tab) => [tab.id, tab.sortOrder])
    ).toEqual([
      ['a', 2],
      ['b', 0],
      ['outside', 1],
      ['last', 3]
    ])
  })

  it('explicit strip ungrouping does not sandwich-rejoin a member left at an interior index', () => {
    seedPane(['a', 'b', 'c'], [cluster('c', ['a', 'b', 'c'])])
    store.getState().moveTabsInStrip(PANE, ['b'], { index: 1, clusterId: null })
    expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual(['a', 'b', 'c'])
    expect(store.getState().groupsByWorktree[WT][0].tabClusters).toEqual([cluster('c', ['a'])])
  })

  it('ignores invalid strip destinations and foreign tab ids', () => {
    seedPane(['a', 'b'], [cluster('c', ['a'])])
    const before = store.getState()
    store.getState().moveTabsInStrip(PANE, ['b'], { index: 0, clusterId: 'missing' })
    store.getState().moveTabsInStrip(PANE, ['foreign'], { index: 0, clusterId: null })
    expect(store.getState()).toBe(before)
  })

  it('normalizes externally inserted sandwich tabs and repairs discontiguous membership eagerly', () => {
    seedPane(['a', 'b', 'x', 'y', 'c', 'd'], [cluster('c', ['a', 'b'])])
    store.setState((state) => ({
      groupsByWorktree: {
        [WT]: [
          {
            ...state.groupsByWorktree[WT][0],
            tabClusters: [cluster('c', ['a', 'b', 'c', 'd'])]
          }
        ]
      }
    }))
    expect(store.getState().groupsByWorktree[WT][0].tabClusters).toEqual([cluster('c', ['a', 'b'])])
    store
      .getState()
      .createUnifiedTab(WT, 'editor', { id: 'between', afterTabId: 'a', activate: false })
    expect(store.getState().groupsByWorktree[WT][0].tabClusters?.[0].tabIds).toEqual([
      'a',
      'between',
      'b'
    ])
  })

  it('close-last-member removes the cluster and pinning immediately removes membership', () => {
    seedPane(['a', 'b', 'outside'], [cluster('c', ['a', 'b'])])
    store.getState().pinTab('a')
    expect(store.getState().groupsByWorktree[WT][0].tabClusters).toEqual([cluster('c', ['b'])])
    store.getState().closeUnifiedTab('b')
    expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual(['a', 'outside'])
    expect(Object.hasOwn(store.getState().groupsByWorktree[WT][0], 'tabClusters')).toBe(false)
  })

  it('joins new tabs anchored on cluster members but not plain or pinned new tabs', () => {
    seedPane(['a', 'b', 'outside'], [cluster('c', ['a', 'b'], { collapsed: true })])
    store
      .getState()
      .createUnifiedTab(WT, 'browser', { id: 'anchored', afterTabId: 'b', activate: false })
    store.getState().createUnifiedTab(WT, 'browser', { id: 'plain', activate: false })
    store.getState().createUnifiedTab(WT, 'browser', {
      id: 'pin',
      afterTabId: 'a',
      isPinned: true,
      activate: false
    })
    const pane = store.getState().groupsByWorktree[WT][0]
    expect(pane.tabClusters).toEqual([cluster('c', ['a', 'b', 'anchored'], { collapsed: true })])
    expect(pane.tabOrder).toEqual(['pin', 'a', 'b', 'anchored', 'outside', 'plain'])
    expect(pane.activeTabId).toBe('a')
  })

  it('sets, sanitizes and clears per-pane highlight selections without changing the active tab', () => {
    seedPane(['a', 'b', 'c'])
    store.getState().setTabSelection(PANE, { tabIds: ['c', 'a', 'a', 'foreign'], anchorTabId: 'c' })
    expect(store.getState().tabSelectionByGroupId[PANE]).toEqual({
      tabIds: ['a', 'c'],
      anchorTabId: 'c'
    })
    expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe('a')
    store.getState().closeUnifiedTab('c')
    expect(store.getState().tabSelectionByGroupId[PANE]).toEqual({
      tabIds: ['a'],
      anchorTabId: null
    })
    store.getState().setTabSelection(PANE, null)
    expect(store.getState().tabSelectionByGroupId).toEqual({})
  })

  it('prunes selections for dead panes and missing backing tabs, even in panes without clusters', () => {
    seedPane(['a', 'b'])
    store.getState().setTabSelection(PANE, { tabIds: ['a', 'b'], anchorTabId: 'b' })
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        [WT]: state.unifiedTabsByWorktree[WT].filter((tab) => tab.id !== 'b')
      }
    }))
    expect(store.getState().tabSelectionByGroupId[PANE]).toEqual({
      tabIds: ['a'],
      anchorTabId: null
    })
    store.setState({ groupsByWorktree: {} })
    expect(store.getState().tabSelectionByGroupId).toEqual({})
  })

  it('keeps normalized pane references on unrelated tab changes without entering a repair loop', () => {
    seedPane(['a', 'b'], [cluster('c', ['a', 'b'])])
    const beforeGroups = store.getState().groupsByWorktree
    store.getState().setTabLabel('a', 'new title')
    expect(store.getState().groupsByWorktree).toBe(beforeGroups)
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        [WT]: state.unifiedTabsByWorktree[WT].map((tab) =>
          tab.id === 'b' ? { ...tab, isPinned: true } : tab
        )
      }
    }))
    const pane = store.getState().groupsByWorktree[WT][0]
    expect(pane.tabClusters).toEqual([cluster('c', ['a'])])
    store.setState((state) => ({ groupsByWorktree: { [WT]: [state.groupsByWorktree[WT][0]] } }))
    expect(store.getState().groupsByWorktree[WT][0]).toBe(pane)
  })
})
