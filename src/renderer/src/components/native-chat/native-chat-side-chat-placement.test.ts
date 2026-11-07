import { beforeEach, expect, it, vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type * as MovedTabSelection from '@/store/slices/tabs/moved-tab-selection'

type Tab = { id: string; worktreeId: string; groupId: string; entityId: string }
type Group = { id: string; activeTabId: string | null; tabOrder: string[] }
type State = {
  activeWorktreeId: string | null
  activeGroupIdByWorktree: Record<string, string>
  groupsByWorktree: Record<string, Group[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
  layoutByWorktree: Record<string, unknown>
  activateTab: (tabId: string) => void
}

const mocks = vi.hoisted(() => ({
  activateTab: vi.fn(),
  moveTabToGroup: vi.fn(),
  moveTabToNewPaneColumn: vi.fn(),
  lookups: 0,
  selectionReads: 0
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store.getState(),
    subscribe: (listener: (state: State, previous: State) => void) => store.subscribe(listener)
  }
}))
vi.mock('@/store/slices/tabs', () => ({ findSiblingGroupId: () => 'g-right' }))
vi.mock('@/store/slices/tabs/moved-tab-selection', async (importOriginal) => {
  const actual = await importOriginal<typeof MovedTabSelection>()
  return {
    tabSelectionKey: (...args: Parameters<typeof actual.tabSelectionKey>) => {
      mocks.selectionReads++
      return actual.tabSelectionKey(...args)
    }
  }
})
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-surface', () => ({
  findStructuredLaunchTab: (args: { worktreeId: string; sessionId: string }) => {
    mocks.lookups++
    return (
      store
        .getState()
        .unifiedTabsByWorktree[args.worktreeId]?.find((tab) => tab.entityId === args.sessionId) ??
      null
    )
  }
}))
vi.mock('@/runtime/layout-owner-pending-tabs', () => ({
  afterPendingTab: (tabId: string, run: (outcome: string | null) => void) => run(tabId)
}))
vi.mock('../tab-bar/tab-move-to-pane-column', () => ({
  canMoveTabToNewPaneColumn: () => true,
  moveTabToGroup: mocks.moveTabToGroup,
  moveTabToNewPaneColumn: mocks.moveTabToNewPaneColumn
}))

import { beginNativeChatSideChatPlacement } from './native-chat-side-chat-placement'

let store: StoreApi<State>

const source: Tab = { id: 'tab-source', worktreeId: 'wt-1', groupId: 'g-left', entityId: 'src' }
const chat = { sessionId: 'side', executionHostId: 'local' as const }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.lookups = 0
  mocks.selectionReads = 0
  store = createStore<State>(() => ({
    activeWorktreeId: 'wt-1',
    activeGroupIdByWorktree: { 'wt-1': 'g-left', 'wt-2': 'g-other' },
    groupsByWorktree: {
      'wt-1': [
        { id: 'g-left', activeTabId: 'tab-source', tabOrder: ['tab-source'] },
        { id: 'g-right', activeTabId: null, tabOrder: [] }
      ],
      'wt-2': [{ id: 'g-other', activeTabId: null, tabOrder: [] }]
    },
    unifiedTabsByWorktree: { 'wt-1': [source], 'wt-2': [] },
    layoutByWorktree: { 'wt-1': {} },
    activateTab: mocks.activateTab
  }))
})

function publishSideChat(): void {
  const state = store.getState()
  store.setState({
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      'wt-1': [source, { id: 'tab-side', worktreeId: 'wt-1', groupId: 'g-left', entityId: 'side' }]
    }
  })
}

function selectGroup(groupId: string): void {
  store.setState({
    activeGroupIdByWorktree: { ...store.getState().activeGroupIdByWorktree, 'wt-1': groupId }
  })
}

it('selects and moves the side chat beside its source once a later frame draws it', () => {
  beginNativeChatSideChatPlacement('wt-1', 'tab-source').settle(chat)
  expect(mocks.activateTab).not.toHaveBeenCalled()

  publishSideChat()

  expect(mocks.activateTab).toHaveBeenCalledWith('tab-side', { worktreeId: 'wt-1' })
  expect(mocks.moveTabToGroup).toHaveBeenCalledWith({
    worktreeId: 'wt-1',
    unifiedTabId: 'tab-side',
    groupId: 'g-right'
  })
})

it('leaves it in the background once the user selected elsewhere, even after going back', () => {
  const placement = beginNativeChatSideChatPlacement('wt-1', 'tab-source')
  selectGroup('g-right')
  selectGroup('g-left')
  placement.settle(chat)
  publishSideChat()

  expect(mocks.activateTab).not.toHaveBeenCalled()
  expect(mocks.moveTabToGroup).not.toHaveBeenCalled()
})

it('leaves a fork whose question never went out in the background', () => {
  beginNativeChatSideChatPlacement('wt-1', 'tab-source').settle(undefined)
  publishSideChat()

  expect(mocks.activateTab).not.toHaveBeenCalled()
})

it.each([10, 100])('does no placement work for %i updates to another workspace', (updates) => {
  beginNativeChatSideChatPlacement('wt-1', 'tab-source').settle(chat)
  const before = { lookups: mocks.lookups, selectionReads: mocks.selectionReads }

  for (let index = 0; index < updates; index++) {
    const state = store.getState()
    store.setState({
      unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, 'wt-2': [] },
      groupsByWorktree: {
        ...state.groupsByWorktree,
        'wt-2': [{ id: 'g-other', activeTabId: `tab-${index}`, tabOrder: [] }]
      }
    })
  }

  expect({ lookups: mocks.lookups, selectionReads: mocks.selectionReads }).toEqual(before)
})

it('does no work once placed', () => {
  beginNativeChatSideChatPlacement('wt-1', 'tab-source').settle(chat)
  publishSideChat()
  const before = { lookups: mocks.lookups, selectionReads: mocks.selectionReads }

  selectGroup('g-right')
  publishSideChat()

  expect({ lookups: mocks.lookups, selectionReads: mocks.selectionReads }).toEqual(before)
  expect(mocks.activateTab).toHaveBeenCalledTimes(1)
})
