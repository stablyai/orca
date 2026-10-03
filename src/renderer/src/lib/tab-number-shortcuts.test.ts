import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import type { AppState } from '@/store/types'
import {
  createTestStore,
  makeOpenFile,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore,
  TEST_REPO
} from '../store/slices/store-test-helpers'
import { getHiddenClusterTabIds } from '../store/slices/tabs/tab-cluster-model'
import { activateTabNumberShortcut, resolveTabNumberShortcutTarget } from './tab-number-shortcuts'

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn<() => AppState>() }))
vi.mock('../store', () => ({ useAppStore: { getState: getStateMock } }))
vi.mock('./focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: () => false
}))

function tab(overrides: Partial<Tab> & Pick<Tab, 'id' | 'groupId'>): Tab {
  return {
    id: overrides.id,
    entityId: overrides.entityId ?? overrides.id,
    groupId: overrides.groupId,
    worktreeId: overrides.worktreeId ?? 'wt-1',
    contentType: overrides.contentType ?? 'terminal',
    label: overrides.label ?? overrides.id,
    customLabel: overrides.customLabel ?? null,
    color: overrides.color ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 0,
    isPreview: overrides.isPreview,
    isPinned: overrides.isPinned
  }
}

function state(overrides: {
  activeView?: AppState['activeView']
  activeWorktreeId?: string | null
  activeGroupId?: string
  groups?: TabGroup[]
  tabs?: Tab[]
}): Pick<
  AppState,
  | 'activeGroupIdByWorktree'
  | 'activeView'
  | 'activeWorktreeId'
  | 'groupsByWorktree'
  | 'repos'
  | 'settings'
  | 'unifiedTabsByWorktree'
  | 'worktreesByRepo'
> {
  const worktreeId = overrides.activeWorktreeId ?? 'wt-1'
  return {
    activeView: overrides.activeView ?? 'terminal',
    activeWorktreeId: worktreeId,
    activeGroupIdByWorktree:
      worktreeId === null ? {} : { [worktreeId]: overrides.activeGroupId ?? 'group-a' },
    groupsByWorktree: worktreeId === null ? {} : { [worktreeId]: overrides.groups ?? [] },
    repos: worktreeId === null ? [] : [{ ...TEST_REPO, id: 'repo-1', executionHostId: 'local' }],
    settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: null }),
    worktreesByRepo:
      worktreeId === null ? {} : { 'repo-1': [makeWorktree({ id: worktreeId, repoId: 'repo-1' })] },
    unifiedTabsByWorktree: worktreeId === null ? {} : { [worktreeId]: overrides.tabs ?? [] }
  }
}

function stickyStore(stickyType: 'terminal' | 'editor' | 'browser') {
  const worktreeId = 'repo1::/tmp/feature'
  const groupId = 'group-a'
  const tabOrder = ['left', 'a', 'b', 'c', 'x']
  const tabs = tabOrder.map((id, sortOrder) => {
    const contentType =
      id === 'a'
        ? stickyType
        : id === 'b'
          ? stickyType === 'terminal'
            ? 'editor'
            : 'terminal'
          : id === 'c'
            ? stickyType === 'browser'
              ? 'editor'
              : 'browser'
            : 'terminal'
    return makeUnifiedTab({
      id,
      entityId: `${contentType}-${id}`,
      contentType,
      worktreeId,
      groupId,
      sortOrder
    })
  })
  const store = createTestStore()
  seedStore(store, {
    activeView: 'terminal',
    activeWorktreeId: worktreeId,
    activeTabId: 'terminal-x',
    activeTabType: 'terminal',
    activeGroupIdByWorktree: { [worktreeId]: groupId },
    worktreesByRepo: { repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })] },
    unifiedTabsByWorktree: { [worktreeId]: tabs },
    tabsByWorktree: {
      [worktreeId]: tabs
        .filter((tab) => tab.contentType === 'terminal')
        .map((tab) => makeTab({ id: tab.entityId, worktreeId }))
    },
    openFiles: tabs
      .filter((tab) => tab.contentType === 'editor')
      .map((tab) => makeOpenFile({ id: tab.entityId, worktreeId })),
    browserTabsByWorktree: {
      [worktreeId]: tabs
        .filter((tab) => tab.contentType === 'browser')
        .map((tab) => ({
          id: tab.entityId,
          worktreeId,
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
      [worktreeId]: [
        makeTabGroup({
          id: groupId,
          worktreeId,
          tabOrder,
          activeTabId: 'x',
          tabClusters: [
            {
              id: 'cluster',
              name: 'Mixed work',
              color: 'blue',
              collapsed: true,
              tabIds: ['a', 'b', 'c'],
              shownTabId: 'a'
            }
          ]
        })
      ]
    },
    layoutByWorktree: { [worktreeId]: { type: 'leaf', groupId } }
  })
  getStateMock.mockImplementation(() => store.getState())
  return { store, worktreeId }
}

beforeEach(() => vi.clearAllMocks())

describe('resolveTabNumberShortcutTarget', () => {
  it('resolves by the active group tab order', () => {
    const first = tab({ id: 'tab-1', groupId: 'group-a' })
    const second = tab({ id: 'tab-2', groupId: 'group-a' })
    const third = tab({ id: 'tab-3', groupId: 'group-a' })

    expect(
      resolveTabNumberShortcutTarget(
        state({
          groups: [
            {
              id: 'group-a',
              worktreeId: 'wt-1',
              activeTabId: null,
              tabOrder: ['tab-2', 'tab-3', 'tab-1']
            }
          ],
          tabs: [first, second, third]
        }),
        1
      )
    ).toBe(third)
  })

  it('ignores stale duplicate ids and appends current group tabs missing from tabOrder', () => {
    const first = tab({ id: 'tab-1', groupId: 'group-a' })
    const second = tab({ id: 'tab-2', groupId: 'group-a' })

    expect(
      resolveTabNumberShortcutTarget(
        state({
          groups: [
            {
              id: 'group-a',
              worktreeId: 'wt-1',
              activeTabId: null,
              tabOrder: ['stale', 'tab-1', 'tab-1']
            }
          ],
          tabs: [first, second]
        }),
        1
      )
    ).toBe(second)
  })

  it('numbers visible tabs through Cmd/Ctrl+9 and retains the active collapsed member', () => {
    const outside = Array.from({ length: 8 }, (_, index) => `outside-${index}`)
    const tabOrder = [
      outside[0],
      'hidden-before',
      'active-member',
      'hidden-after',
      ...outside.slice(1)
    ]
    const tabs = tabOrder.map((id) => tab({ id, groupId: 'group-a' }))
    const group: TabGroup = {
      id: 'group-a',
      worktreeId: 'wt-1',
      activeTabId: 'active-member',
      tabOrder,
      tabClusters: [
        {
          id: 'cluster',
          name: 'Work',
          color: 'blue',
          collapsed: true,
          tabIds: ['hidden-before', 'active-member', 'hidden-after']
        }
      ]
    }
    const current = state({ groups: [group], tabs })

    expect(resolveTabNumberShortcutTarget(current, 0)?.id).toBe('outside-0')
    expect(resolveTabNumberShortcutTarget(current, 1)?.id).toBe('active-member')
    expect(resolveTabNumberShortcutTarget(current, 2)?.id).toBe('outside-1')
    expect(resolveTabNumberShortcutTarget(current, 8)?.id).toBe('outside-7')
    expect(resolveTabNumberShortcutTarget(current, 9)).toBeNull()

    const away = state({ groups: [{ ...group, activeTabId: 'outside-0' }], tabs })
    expect(resolveTabNumberShortcutTarget(away, 1)?.id).toBe('outside-1')
    expect(resolveTabNumberShortcutTarget(away, 8)).toBeNull()
  })

  it.each(['terminal', 'editor', 'browser'] as const)(
    'activates the nth visible tab including a sticky %s member while outside its mixed cluster',
    (stickyType) => {
      const { store, worktreeId } = stickyStore(stickyType)
      expect([...getHiddenClusterTabIds(store.getState().groupsByWorktree[worktreeId][0])]).toEqual(
        ['b', 'c']
      )
      for (const [index, id] of ['left', 'a', 'x'].entries()) {
        expect(resolveTabNumberShortcutTarget(store.getState(), index)?.id).toBe(id)
        expect(activateTabNumberShortcut(index)).toBe(true)
        const state = store.getState()
        expect(state.getActiveTab(worktreeId)?.id).toBe(id)
        const expectedType = id === 'a' ? stickyType : 'terminal'
        expect(state.activeTabType).toBe(expectedType)
        if (expectedType === 'editor') {
          expect(state.activeFileId).toBe(`editor-${id}`)
        } else if (expectedType === 'browser') {
          expect(state.activeBrowserTabId).toBe(`browser-${id}`)
        } else {
          expect(state.activeTabId).toBe(`terminal-${id}`)
        }
        const pane = state.groupsByWorktree[worktreeId][0]
        expect(pane.tabClusters?.[0]).toMatchObject({ collapsed: true, shownTabId: 'a' })
        expect([...getHiddenClusterTabIds(pane)]).toEqual(['b', 'c'])
      }
      expect(resolveTabNumberShortcutTarget(store.getState(), 3)).toBeNull()
      expect(activateTabNumberShortcut(3)).toBe(false)
      expect(store.getState().getActiveTab(worktreeId)?.id).toBe('x')
    }
  )

  it('uses only the active split group', () => {
    const otherGroupTab = tab({ id: 'tab-other', groupId: 'group-a' })
    const activeGroupTab = tab({ id: 'tab-active', groupId: 'group-b' })

    expect(
      resolveTabNumberShortcutTarget(
        state({
          activeGroupId: 'group-b',
          groups: [
            { id: 'group-a', worktreeId: 'wt-1', activeTabId: null, tabOrder: ['tab-other'] },
            { id: 'group-b', worktreeId: 'wt-1', activeTabId: null, tabOrder: ['tab-active'] }
          ],
          tabs: [otherGroupTab, activeGroupTab]
        }),
        0
      )
    ).toBe(activeGroupTab)
  })

  it('returns null outside terminal workspaces or out of range', () => {
    const only = tab({ id: 'tab-1', groupId: 'group-a' })
    const base = state({
      groups: [{ id: 'group-a', worktreeId: 'wt-1', activeTabId: null, tabOrder: ['tab-1'] }],
      tabs: [only]
    })

    expect(resolveTabNumberShortcutTarget(base, 2)).toBeNull()
    expect(resolveTabNumberShortcutTarget({ ...base, activeView: 'settings' }, 0)).toBeNull()
    expect(resolveTabNumberShortcutTarget({ ...base, activeWorktreeId: null }, 0)).toBeNull()
    expect(resolveTabNumberShortcutTarget(base, -1)).toBeNull()
  })
})
