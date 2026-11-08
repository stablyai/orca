import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { TabDropCompletion } from '../../../tab-group/tab-group-layout-owner-commands'

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
  focusComposer: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store.getState(),
    subscribe: (listener: (state: State, previous: State) => void) => store.subscribe(listener)
  }
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-surface', () => ({
  findStructuredLaunchTab: (args: { worktreeId: string; sessionId: string }) => {
    return (
      store
        .getState()
        .unifiedTabsByWorktree[args.worktreeId]?.find((tab) => tab.entityId === args.sessionId) ??
      null
    )
  }
}))
vi.mock('@/runtime/workspace-layout/intents/layout-owner-pending-tabs', () => ({
  afterPendingTab: (tabId: string, run: (outcome: string | null) => void) => run(tabId)
}))
vi.mock('../../composer/focus/native-chat-composer-focus-intent', () => ({
  requestNativeChatComposerFocus: mocks.focusComposer
}))
vi.mock('../../../tab-bar/tab-move-to-pane-column', () => ({
  canMoveTabToNewPaneColumn: () => true,
  moveTabToGroup: mocks.moveTabToGroup,
  moveTabToNewPaneColumn: mocks.moveTabToNewPaneColumn
}))

import { beginNativeChatSideChatPlacement } from './native-chat-side-chat-placement'

let store: StoreApi<State>

function group(id: string, activeTabId: string | null, tabOrder: string[]): Group {
  return {
    id,
    activeTabId,
    tabOrder
  }
}

const source: Tab = { id: 'tab-source', worktreeId: 'wt-1', groupId: 'g-left', entityId: 'src' }
const chat = { sessionId: 'side', executionHostId: 'local' as const }

beforeEach(() => {
  vi.clearAllMocks()
  store = createStore<State>(() => ({
    activeWorktreeId: 'wt-1',
    activeGroupIdByWorktree: { 'wt-1': 'g-left', 'wt-2': 'g-other' },
    groupsByWorktree: {
      'wt-1': [group('g-left', 'tab-source', ['tab-source']), group('g-right', null, [])],
      'wt-2': [group('g-other', null, [])]
    },
    unifiedTabsByWorktree: { 'wt-1': [source], 'wt-2': [] },
    layoutByWorktree: {
      'wt-1': {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'g-left' },
        second: { type: 'leaf', groupId: 'g-right' }
      }
    },
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
  expect(mocks.focusComposer).toHaveBeenCalledWith('tab-side')
  expect(mocks.moveTabToGroup.mock.calls[0]?.[0]).toEqual({
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

describe('when main draws the move', () => {
  let completion: TabDropCompletion | undefined
  beforeEach(() => {
    completion = undefined
    mocks.moveTabToGroup.mockImplementationOnce(
      (_args: unknown, _drop: unknown, given: TabDropCompletion) => {
        completion = given
        return 'owner'
      }
    )
  })

  /** Main's frame: the side chat now shows in the right pane. */
  function drawMove(): void {
    const state = store.getState()
    store.setState({
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        'wt-1': [
          source,
          { id: 'tab-side', worktreeId: 'wt-1', groupId: 'g-right', entityId: 'side' }
        ]
      },
      groupsByWorktree: {
        ...state.groupsByWorktree,
        'wt-1': [
          group('g-left', 'tab-source', ['tab-source']),
          group('g-right', 'tab-side', ['tab-side'])
        ]
      }
    })
  }

  it('selects and focuses the side chat only once the frame shows it moved, however late', () => {
    beginNativeChatSideChatPlacement('wt-1', 'tab-source').settle(chat)
    publishSideChat()
    expect(mocks.activateTab).not.toHaveBeenCalled()
    expect(mocks.focusComposer).not.toHaveBeenCalled()

    drawMove()

    expect(mocks.activateTab).toHaveBeenCalledWith('tab-side', { worktreeId: 'wt-1' })
    expect(mocks.focusComposer).toHaveBeenCalledWith('tab-side')
  })

  it('reads the new pane main opens for it, and its selection there, as its own', () => {
    beginNativeChatSideChatPlacement('wt-1', 'tab-source').settle(chat)
    publishSideChat()
    const state = store.getState()

    store.setState({
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        'wt-1': [source, { id: 'tab-side', worktreeId: 'wt-1', groupId: 'g-new', entityId: 'side' }]
      },
      groupsByWorktree: {
        ...state.groupsByWorktree,
        'wt-1': [
          ...(state.groupsByWorktree['wt-1'] ?? []),
          group('g-new', 'tab-side', ['tab-side'])
        ]
      },
      activeGroupIdByWorktree: { ...state.activeGroupIdByWorktree, 'wt-1': 'g-new' }
    })

    expect(mocks.activateTab).toHaveBeenCalledWith('tab-side', { worktreeId: 'wt-1' })
  })

  it('stays in the background after the user selects it in the pane it is leaving and goes back', () => {
    beginNativeChatSideChatPlacement('wt-1', 'tab-source').settle(chat)
    publishSideChat()
    const sourcePane = (activeTabId: string): void =>
      store.setState({
        groupsByWorktree: {
          ...store.getState().groupsByWorktree,
          'wt-1': [
            group('g-left', activeTabId, ['tab-source', 'tab-side']),
            group('g-right', null, [])
          ]
        }
      })

    sourcePane('tab-side')
    sourcePane('tab-source')
    drawMove()
    completion?.refused()

    expect(mocks.activateTab).not.toHaveBeenCalled()
  })

  it('selects the side chat where it is when main never answers the move', () => {
    vi.useFakeTimers()
    try {
      beginNativeChatSideChatPlacement('wt-1', 'tab-source').settle(chat)
      publishSideChat()

      vi.advanceTimersByTime(60_000)

      expect(mocks.activateTab).toHaveBeenCalledWith('tab-side', { worktreeId: 'wt-1' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('selects the side chat where it is when main refuses the move', () => {
    beginNativeChatSideChatPlacement('wt-1', 'tab-source').settle(chat)
    publishSideChat()

    completion?.refused()

    expect(mocks.activateTab).toHaveBeenCalledWith('tab-side', { worktreeId: 'wt-1' })
    expect(mocks.focusComposer).toHaveBeenCalledWith('tab-side')
  })

  it('stays in the background after the user selects elsewhere and back while main draws', () => {
    beginNativeChatSideChatPlacement('wt-1', 'tab-source').settle(chat)
    publishSideChat()

    selectGroup('g-right')
    selectGroup('g-left')
    drawMove()
    completion?.refused()
    const move = vi.fn()
    completion?.moveHere(move)

    expect(mocks.activateTab).not.toHaveBeenCalled()
    expect(mocks.focusComposer).not.toHaveBeenCalled()
    expect(move).not.toHaveBeenCalled()
  })
})
