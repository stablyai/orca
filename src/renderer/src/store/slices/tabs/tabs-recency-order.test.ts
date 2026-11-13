import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../../shared/tab-types'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { resetTerminalInputActivityCoalescingForTests } from '@/lib/terminal/input/terminal-input-activity-coalescing'
import { activateCyclableTab } from '@/hooks/ipc-tab-switch'
import { activateTabNumberShortcut } from '@/lib/keyboard/tab-number-shortcuts'
import { useAppStore } from '@/store'
import { completeNativeChatStructuredUserAction } from '@/components/native-chat/composer/submit/native-chat-structured-user-action'
import type { NativeChatStructuredComposerTransport } from '@/components/native-chat/composer/submit/native-chat-structured-composer-transport'

vi.mock('@/components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))

vi.mock('@/lib/workspace/tabs/cycled-tab-owner-activation', () => ({
  activateCycledTabOnOwner: vi.fn()
}))

vi.mock('@/runtime/workspace-layout/commands/layout-apply-send', () => ({
  recordLayoutApply: vi.fn()
}))

createTabsSliceMockApi()

const WT = 'folder-workspace'
const LEAF = '00000000-0000-4000-8000-000000000001'

function tab(id: string, groupId = 'left', isPinned = false): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: WT,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    isPinned
  }
}

describe('tab bar recency ordering', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
    store.setState({
      activeWorktreeId: WT,
      unifiedTabsByWorktree: {
        [WT]: [
          tab('pin-1', 'left', true),
          tab('pin-2', 'left', true),
          tab('a'),
          tab('b'),
          tab('c'),
          tab('right', 'right')
        ]
      },
      groupsByWorktree: {
        [WT]: [
          {
            id: 'left',
            worktreeId: WT,
            activeTabId: 'a',
            tabOrder: ['pin-1', 'pin-2', 'a', 'b', 'c']
          },
          { id: 'right', worktreeId: WT, activeTabId: 'right', tabOrder: ['right'] }
        ]
      },
      activeGroupIdByWorktree: { [WT]: 'left' }
    })
  })

  afterEach(() => {
    resetTerminalInputActivityCoalescingForTests()
    vi.restoreAllMocks()
  })

  function enable(): void {
    store.setState({ settings: { ...store.getState().settings!, tabBarOrderMode: 'mru' } })
  }

  function order(): string[] {
    return store.getState().groupsByWorktree[WT][0].tabOrder
  }

  it('keeps manual ordering by default when the user types', () => {
    store.getState().recordTerminalInput(`c:${LEAF}`, 100)
    store.getState().recordTabInteraction('c')
    expect(order()).toEqual(['pin-1', 'pin-2', 'a', 'b', 'c'])
    enable()
    store.getState().recordTerminalInput(`c:${LEAF}`, 200)
    expect(order()).toEqual(['pin-1', 'pin-2', 'c', 'a', 'b'])
  })

  it('promotes typed tabs behind stable pins, within their own split', () => {
    enable()
    store.getState().recordTerminalInput(`c:${LEAF}`, 100)
    store.getState().recordTerminalInput(`b:${LEAF}`, 200)
    expect(order()).toEqual(['pin-1', 'pin-2', 'b', 'c', 'a'])
    expect(store.getState().groupsByWorktree[WT][1].tabOrder).toEqual(['right'])
    store.getState().recordTabInteraction('pin-1')
    expect(order()).toEqual(['pin-1', 'pin-2', 'b', 'c', 'a'])
  })

  it('keeps pointer activation and background title updates in place', () => {
    enable()
    store.getState().activateTab('c', { worktreeId: WT })
    store.getState().setTabLabel('b', 'Streaming output')
    expect(order()).toEqual(['pin-1', 'pin-2', 'a', 'b', 'c'])
    activateCyclableTab(store.getState(), { type: 'terminal', id: 'c', tabId: 'c' })
    expect(order()).toEqual(['pin-1', 'pin-2', 'c', 'a', 'b'])
  })

  it('reorders only the named workspace when tab and group IDs overlap', () => {
    enable()
    store.setState({
      unifiedTabsByWorktree: {
        ...store.getState().unifiedTabsByWorktree,
        other: [
          { ...tab('a'), worktreeId: 'other' },
          { ...tab('c'), worktreeId: 'other' }
        ]
      },
      groupsByWorktree: {
        ...store.getState().groupsByWorktree,
        other: [{ id: 'left', worktreeId: 'other', activeTabId: 'a', tabOrder: ['a', 'c'] }]
      }
    })
    store.getState().recordTabInteraction('c', { worktreeId: 'other' })
    expect(store.getState().groupsByWorktree.other[0].tabOrder).toEqual(['c', 'a'])
    expect(order()).toEqual(['pin-1', 'pin-2', 'a', 'b', 'c'])
  })

  it('promotes a tab selected with a number shortcut', () => {
    enable()
    store.setState({ activeView: 'terminal' })
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    expect(activateTabNumberShortcut(4)).toBe(true)
    expect(order()).toEqual(['pin-1', 'pin-2', 'c', 'a', 'b'])
  })

  it('promotes the chat that accepted a remote prompt after the user changes workspace', () => {
    enable()
    store.setState({ activeWorktreeId: 'other' })
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    const transport: NativeChatStructuredComposerTransport = {
      tabId: 'c',
      worktreeId: WT,
      capturePresentation: () => () => true,
      send: () => true,
      dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
      optionsSurface: {
        getSnapshot: () => [],
        setOption: async () => ({ snapshot: [] }),
        invokeAction: async () => ({ snapshot: [] }),
        subscribe: () => () => {}
      },
      optionSnapshot: [],
      onError: () => {},
      runtime: 'remote',
      sessionId: 'session-c',
      runtimeEnvironmentId: 'ssh-host'
    }
    completeNativeChatStructuredUserAction('codex', transport, undefined)
    expect(order()).toEqual(['pin-1', 'pin-2', 'c', 'a', 'b'])
  })

  it('keeps a dragged order until the next interaction and freezes it in manual mode', () => {
    enable()
    store.getState().recordTabInteraction('c')
    store.getState().reorderUnifiedTabs('left', ['pin-2', 'pin-1', 'a', 'b', 'c'])
    expect(order()).toEqual(['pin-2', 'pin-1', 'a', 'b', 'c'])
    store.getState().recordTabInteraction('b')
    expect(order()).toEqual(['pin-2', 'pin-1', 'b', 'a', 'c'])
    store.setState({ settings: { ...store.getState().settings!, tabBarOrderMode: 'manual' } })
    store.getState().recordTabInteraction('c')
    expect(order()).toEqual(['pin-2', 'pin-1', 'b', 'a', 'c'])
  })
})
