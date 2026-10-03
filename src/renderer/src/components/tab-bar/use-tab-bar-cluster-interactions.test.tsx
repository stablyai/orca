// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabCluster, TabGroup } from '../../../../shared/tab-types'
import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import type { AppState } from '@/store/types'
import {
  createTestStore,
  makeLayout,
  makeTabGroup,
  makeUnifiedTab,
  seedStore,
  type TestStore
} from '@/store/slices/store-test-helpers'
import type { TabBarItem } from './tab-bar-item-model'
import type { TabBarProps } from './tab-bar-props'
import { useTabBarClusterInteractions } from './use-tab-bar-cluster-interactions'

let store: TestStore
let probeClock = 0
const inspectRuntimeTerminalProcessMock = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => store(selector), {
    getState: () => store.getState()
  })
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

const LEAF = '11111111-1111-4111-8111-111111111111'
const CLUSTER: TabCluster = {
  id: 'cluster',
  name: 'Development',
  color: 'blue',
  collapsed: true,
  tabIds: ['unified-first', 'file-tab', 'unified-second']
}
const GROUP: TabGroup = {
  id: 'pane',
  worktreeId: 'wt',
  activeTabId: 'outside',
  tabOrder: [...CLUSTER.tabIds, 'outside'],
  tabClusters: [CLUSTER]
}

function terminalItem(
  unifiedTabId: string,
  entityId: string,
  label: string,
  customTitle: string | null = null
): TabBarItem {
  return {
    type: 'terminal',
    id: entityId,
    unifiedTabId,
    isPinned: false,
    data: {
      id: entityId,
      worktreeId: 'wt',
      ptyId: null,
      title: label,
      customTitle,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
  }
}

const ITEMS: TabBarItem[] = [
  terminalItem('unified-first', 'terminal-first', 'Build'),
  {
    type: 'editor',
    id: 'file-tab',
    unifiedTabId: 'file-tab',
    isPinned: false,
    data: {
      id: 'file-entity',
      filePath: '/workspace/README.md',
      relativePath: 'README.md',
      worktreeId: 'wt',
      language: 'markdown',
      isDirty: true,
      mode: 'edit'
    }
  },
  terminalItem('unified-second', 'terminal-second', 'Agent', 'Review changes'),
  terminalItem('outside', 'terminal-outside', 'Shell')
]
const UNIFIED_TABS: Tab[] = ITEMS.map((item, sortOrder) => ({
  id: item.unifiedTabId,
  entityId: item.data.id,
  groupId: 'pane',
  worktreeId: 'wt',
  contentType: item.type,
  label: item.type === 'terminal' ? item.data.title : 'README.md',
  customLabel: item.type === 'terminal' ? item.data.customTitle : null,
  color: null,
  sortOrder,
  createdAt: 0
}))
const noop = (): void => {}
const PROPS: TabBarProps = {
  tabs: [],
  activeTabId: 'terminal-outside',
  worktreeId: 'wt',
  expandedPaneByTabId: {},
  onActivate: noop,
  onClose: noop,
  onCloseOthers: noop,
  onCloseToRight: noop,
  onCloseToLeft: noop,
  onNewTerminalTab: noop,
  onNewBrowserTab: noop,
  onSetCustomTitle: noop,
  onSetTabColor: noop,
  onTogglePaneExpand: noop
}

function mount(group = GROUP, allItems = ITEMS) {
  return renderHook(() =>
    useTabBarClusterInteractions({
      props: {
        ...PROPS,
        worktreeId: group.worktreeId,
        onCloseTabs: (tabIds) => {
          for (const tabId of tabIds) {
            store.getState().closeUnifiedTab(tabId, { terminalRetirementHandled: true })
          }
        }
      },
      groupId: group.id,
      group,
      allItems,
      visibleItems: allItems.filter((item) => item.unifiedTabId === group.activeTabId),
      activeVisibleTabId: 'terminal-outside'
    })
  )
}

function tabOrder(groupId = 'pane', worktreeId = 'wt'): string[] | undefined {
  return store.getState().groupsByWorktree[worktreeId]?.find((group) => group.id === groupId)
    ?.tabOrder
}

async function settleProbe(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 12; tick += 1) {
      await Promise.resolve()
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  probeClock += 10_000
  vi.useFakeTimers({ now: probeClock })
  store = createTestStore()
  seedStore(store, {
    unifiedTabsByWorktree: { wt: UNIFIED_TABS },
    groupsByWorktree: { wt: [GROUP] },
    ptyIdsByTabId: {
      'terminal-first': ['pty-first'],
      'terminal-second': ['pty-second'],
      'terminal-outside': ['pty-outside']
    },
    terminalLayoutsByTabId: {
      'terminal-first': { ...makeLayout(), ptyIdsByLeafId: { [LEAF]: 'pty-first' } },
      'terminal-second': { ...makeLayout(), ptyIdsByLeafId: { [LEAF]: 'pty-second' } }
    },
    agentStatusByPaneKey: {
      [`terminal-second:${LEAF}`]: {
        paneKey: `terminal-second:${LEAF}`,
        agentType: 'claude',
        state: 'working',
        prompt: '',
        updatedAt: 0,
        stateStartedAt: 0,
        stateHistory: []
      }
    }
  })
  inspectRuntimeTerminalProcessMock.mockResolvedValue({
    foregroundProcess: 'sleep',
    hasChildProcesses: true
  })
})

afterEach(() => {
  cleanup()
  while (useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm) {
    vi.advanceTimersByTime(350)
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
  }
  vi.useRealTimers()
})

describe('closeCluster', () => {
  it('bulk-closes every collapsed member only after the group confirmation', async () => {
    const { result } = mount()
    act(() => result.current.closeCluster(CLUSTER))
    expect(tabOrder()).toEqual(GROUP.tabOrder)
    await settleProbe()

    expect(
      useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
    ).toMatchObject({
      tabLabel: 'Development',
      groupTerminals: [
        { terminalTabId: 'terminal-first', tabLabel: 'Build', copyKind: 'command' },
        { terminalTabId: 'terminal-second', tabLabel: 'Review changes', copyKind: 'agent' }
      ]
    })
    expect(tabOrder()).toEqual(GROUP.tabOrder)
    act(() => useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose())
    expect(tabOrder()).toEqual(['outside'])
    expect(store.getState().unifiedTabsByWorktree.wt.map((tab) => tab.id)).toEqual(['outside'])
    expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
  })

  it('cancelling the group prompt leaves every hidden member open', async () => {
    const { result } = mount()
    act(() => result.current.closeCluster(CLUSTER))
    await settleProbe()
    act(() => useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose())
    expect(tabOrder()).toEqual(GROUP.tabOrder)
    expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
  })

  it('bulk-closes the whole group without a running prompt when its terminals are idle', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    })
    const { result } = mount()
    act(() => result.current.closeCluster(CLUSTER))
    await settleProbe()
    expect(tabOrder()).toEqual(['outside'])
    expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
  })

  it('still guards a host-backed member absent from the strip projection', async () => {
    const { result } = mount(
      GROUP,
      ITEMS.filter((item) => item.unifiedTabId !== 'unified-second')
    )
    act(() => result.current.closeCluster({ ...CLUSTER, name: '' }))
    await settleProbe()
    expect(
      useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
    ).toMatchObject({
      tabLabel: '',
      groupTerminals: [
        { terminalTabId: 'terminal-first', tabLabel: 'Build' },
        { terminalTabId: 'terminal-second', tabLabel: 'Review changes' }
      ]
    })
    expect(tabOrder()).toEqual(GROUP.tabOrder)
  })

  it.each([
    { label: 'different panes', groupId: 'other-pane', worktreeId: 'wt' },
    { label: 'different worktrees', groupId: 'pane', worktreeId: 'other-wt' }
  ])(
    'keeps matching-id groups in $label behind separate prompts',
    async ({ groupId, worktreeId }) => {
      const otherCluster: TabCluster = { ...CLUSTER, name: 'Other group', tabIds: ['other-tab'] }
      const otherGroup = makeTabGroup({
        id: groupId,
        worktreeId,
        activeTabId: 'other-tab',
        tabOrder: ['other-tab', 'other-outside'],
        tabClusters: [otherCluster]
      })
      const state = store.getState()
      seedStore(store, {
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [worktreeId]: [...(state.groupsByWorktree[worktreeId] ?? []), otherGroup]
        },
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [worktreeId]: [
            ...(state.unifiedTabsByWorktree[worktreeId] ?? []),
            makeUnifiedTab({
              id: 'other-tab',
              entityId: 'other-terminal',
              groupId,
              worktreeId,
              label: 'Other task'
            }),
            makeUnifiedTab({ id: 'other-outside', groupId, worktreeId })
          ]
        },
        ptyIdsByTabId: { ...state.ptyIdsByTabId, 'other-terminal': ['other-pty'] }
      })
      const resolveProbes: (() => void)[] = []
      inspectRuntimeTerminalProcessMock.mockImplementation(
        () =>
          new Promise<{ foregroundProcess: string; hasChildProcesses: boolean }>((resolve) => {
            resolveProbes.push(() =>
              resolve({ foregroundProcess: 'sleep', hasChildProcesses: true })
            )
          })
      )
      const first = mount()
      const second = mount(otherGroup, [])
      act(() => {
        first.result.current.closeCluster(CLUSTER)
        second.result.current.closeCluster(otherCluster)
      })
      expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
      act(() => resolveProbes.splice(0, 2).forEach((resolve) => resolve()))
      await settleProbe()
      expect(
        useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm?.tabLabel
      ).toBe('Development')
      act(() => resolveProbes.forEach((resolve) => resolve()))
      await settleProbe()

      act(() => useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose())
      expect(tabOrder()).toEqual(['outside'])
      expect(tabOrder(groupId, worktreeId)).toEqual(['other-tab', 'other-outside'])
      expect(
        useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
      ).toMatchObject({
        tabLabel: 'Other group',
        groupTerminals: [{ terminalTabId: 'other-terminal', tabLabel: 'Other task' }]
      })
      act(() => {
        vi.advanceTimersByTime(350)
        useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
      })
      expect(tabOrder(groupId, worktreeId)).toEqual(['other-outside'])
      expect(tabOrder()).toEqual(['outside'])
      expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
    }
  )
})
