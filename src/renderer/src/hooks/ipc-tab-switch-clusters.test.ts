import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn() }))
vi.mock('../store', () => ({ useAppStore: { getState: getStateMock } }))

import {
  createTestStore,
  makeOpenFile,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore,
  type TestStore
} from '../store/slices/store-test-helpers'
import { getHiddenClusterTabIds } from '../store/slices/tabs/tab-cluster-model'
import {
  activateCyclableTab,
  handleSwitchRecentTab,
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from './ipc-tab-switch'

const WT = 'repo1::/path/wt1'
const GROUP = 'group-1'
const IDS = ['left', 'hidden-before', 'active-member', 'hidden-after', 'right']

function collapsedStore(mixedMembers = false) {
  const store = createTestStore()
  const tabs = IDS.map((id) => {
    const contentType =
      mixedMembers && id === 'hidden-before'
        ? 'editor'
        : mixedMembers && id === 'hidden-after'
          ? 'browser'
          : 'terminal'
    return makeUnifiedTab({
      id,
      entityId: `${contentType}-${id}`,
      contentType,
      worktreeId: WT,
      groupId: GROUP
    })
  })
  seedStore(store, {
    activeWorktreeId: WT,
    activeTabId: 'terminal-active-member',
    activeTabType: 'terminal',
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1' })] },
    activeGroupIdByWorktree: { [WT]: GROUP },
    tabsByWorktree: {
      [WT]: tabs
        .filter((tab) => tab.contentType === 'terminal')
        .map((tab) => makeTab({ id: tab.entityId, worktreeId: WT }))
    },
    unifiedTabsByWorktree: {
      [WT]: tabs
    },
    openFiles: tabs
      .filter((tab) => tab.contentType === 'editor')
      .map((tab) => makeOpenFile({ id: tab.entityId, worktreeId: WT })),
    browserTabsByWorktree: {
      [WT]: tabs
        .filter((tab) => tab.contentType === 'browser')
        .map((tab) => ({
          id: tab.entityId,
          worktreeId: WT,
          url: 'about:blank',
          title: 'Browser',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 0
        }))
    },
    groupsByWorktree: {
      [WT]: [
        makeTabGroup({
          id: GROUP,
          worktreeId: WT,
          activeTabId: 'active-member',
          tabOrder: [...IDS],
          recentTabIds: ['left', 'hidden-before', 'active-member'],
          tabClusters: [
            {
              id: 'cluster',
              name: 'Work',
              color: 'blue',
              collapsed: true,
              tabIds: ['hidden-before', 'active-member', 'hidden-after']
            }
          ]
        })
      ]
    }
  })
  getStateMock.mockImplementation(() => store.getState())
  return store
}

function activate(store: TestStore, tabId: string) {
  const tab = store.getState().getTab(tabId)
  if (
    !tab ||
    (tab.contentType !== 'terminal' &&
      tab.contentType !== 'editor' &&
      tab.contentType !== 'browser')
  ) {
    throw new Error(`No cyclable fixture tab ${tabId}`)
  }
  activateCyclableTab(store.getState(), {
    id: tab.entityId,
    tabId: tab.id,
    type: tab.contentType
  })
}

function stickyStore(mixedMembers: boolean) {
  const store = collapsedStore(mixedMembers)
  store.getState().setTabClusterCollapsed(GROUP, 'cluster', false)
  store.getState().setTabClusterCollapsed(GROUP, 'cluster', true)
  activate(store, 'right')
  return store
}

beforeEach(() => vi.clearAllMocks())

describe('collapsed cluster keyboard cycling', () => {
  it.each([
    { name: 'all types', cycle: handleSwitchTabAcrossAllTypes },
    { name: 'same type', cycle: handleSwitchTab },
    { name: 'terminal only', cycle: handleSwitchTerminalTab }
  ])('$name skips hidden members in both directions', ({ cycle }) => {
    for (const direction of [-1, 1]) {
      const store = collapsedStore()
      expect(cycle(direction)).toBe(true)
      const target = direction < 0 ? 'left' : 'right'
      expect(store.getState().getActiveTab(WT)?.id).toBe(target)
      expect(store.getState().activeTabId).toBe(`terminal-${target}`)
      expect(store.getState().groupsByWorktree[WT]?.[0].tabClusters?.[0].collapsed).toBe(true)
    }
  })

  it('does not mistake intentionally hidden terminals for missing hydrated rows', () => {
    const store = collapsedStore()
    store.setState((state) => ({
      groupsByWorktree: {
        [WT]: state.groupsByWorktree[WT].map((group) => ({
          ...group,
          tabOrder: ['hidden-before', 'active-member', 'hidden-after']
        }))
      },
      unifiedTabsByWorktree: {
        [WT]: state.unifiedTabsByWorktree[WT].filter(
          (tab) => tab.id !== 'left' && tab.id !== 'right'
        )
      },
      tabsByWorktree: {
        [WT]: state.tabsByWorktree[WT].filter(
          (tab) => tab.id !== 'terminal-left' && tab.id !== 'terminal-right'
        )
      }
    }))
    expect(handleSwitchTerminalTab(1)).toBe(false)
    expect(handleSwitchTab(1)).toBe(false)
    expect(handleSwitchTabAcrossAllTypes(-1)).toBe(false)
    expect(store.getState().getActiveTab(WT)?.id).toBe('active-member')
  })

  it('keeps hidden members available to Ctrl+Tab MRU', () => {
    const store = collapsedStore()
    expect(handleSwitchRecentTab()).toBe(true)
    expect(store.getState().getActiveTab(WT)?.id).toBe('hidden-before')
    expect(store.getState().groupsByWorktree[WT]?.[0].tabClusters?.[0].collapsed).toBe(true)
  })

  it.each([
    { name: 'all types', cycle: handleSwitchTabAcrossAllTypes },
    { name: 'same type', cycle: handleSwitchTab },
    { name: 'terminal only', cycle: handleSwitchTerminalTab }
  ])(
    '$name visits the sticky member from outside without revealing hidden members',
    ({ cycle }) => {
      for (const mixedMembers of [false, true]) {
        for (const direction of [-1, 1]) {
          const store = stickyStore(mixedMembers)
          const expected =
            direction < 0 ? ['active-member', 'left', 'right'] : ['left', 'active-member', 'right']
          expect([...getHiddenClusterTabIds(store.getState().groupsByWorktree[WT][0])]).toEqual([
            'hidden-before',
            'hidden-after'
          ])
          for (const tabId of [...expected, ...expected]) {
            expect(cycle(direction)).toBe(true)
            expect(store.getState().getActiveTab(WT)?.id).toBe(tabId)
            expect(store.getState().activeTabId).toBe(`terminal-${tabId}`)
            const pane = store.getState().groupsByWorktree[WT][0]
            expect(pane.tabClusters?.[0]).toMatchObject({
              collapsed: true,
              shownTabId: 'active-member'
            })
            expect([...getHiddenClusterTabIds(pane)]).toEqual(['hidden-before', 'hidden-after'])
          }
        }
      }
    }
  )

  it.each([false, true])(
    'keeps the sticky member visible after Ctrl+Tab MRU visits a hidden member (mixed=%s)',
    (mixedMembers) => {
      const store = stickyStore(mixedMembers)
      activate(store, 'hidden-before')
      activate(store, 'right')

      expect(handleSwitchRecentTab()).toBe(true)
      expect(store.getState().getActiveTab(WT)?.id).toBe('hidden-before')
      expect([...getHiddenClusterTabIds(store.getState().groupsByWorktree[WT][0])]).toEqual([
        'hidden-after'
      ])
      expect(store.getState().activeTabType).toBe(mixedMembers ? 'editor' : 'terminal')
      if (mixedMembers) {
        expect(store.getState().activeFileId).toBe('editor-hidden-before')
      } else {
        expect(store.getState().activeTabId).toBe('terminal-hidden-before')
      }

      activate(store, 'right')
      const pane = store.getState().groupsByWorktree[WT][0]
      expect(pane.activeTabId).toBe('right')
      expect(pane.tabClusters?.[0]).toMatchObject({
        collapsed: true,
        shownTabId: 'active-member'
      })
      expect([...getHiddenClusterTabIds(pane)]).toEqual(['hidden-before', 'hidden-after'])
    }
  )
})
