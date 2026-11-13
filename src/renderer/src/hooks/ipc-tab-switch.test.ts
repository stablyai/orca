import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, getActiveTabNavOrderMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  getActiveTabNavOrderMock: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

vi.mock('@/components/tab-bar/group-tab-order', () => ({
  getActiveTabNavOrder: getActiveTabNavOrderMock
}))

import { createTabsFocusActions } from '../store/slices/tabs/tabs-focus-actions'
import type { TabsSliceGet, TabsSliceSet } from '../store/slices/tabs/tabs-slice-contract'
import {
  handleSwitchRecentTab,
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from './ipc-tab-switch'

type ActiveTabType = 'terminal' | 'editor' | 'browser' | 'simulator' | 'agent-session'

type MockGroup = {
  id: string
  activeTabId: string | null
  tabOrder?: string[]
  recentTabIds?: string[]
}

type MockStore = {
  activeWorktreeId: string
  activeTabType: ActiveTabType
  activeTabId: string
  activeFileId: string
  activeBrowserTabId: string
  activeGroupIdByWorktree: Record<string, string>
  groupsByWorktree: Record<string, MockGroup[]>
  tabsByWorktree: Record<string, { id: string }[]>
  unifiedTabsByWorktree: Record<
    string,
    {
      id: string
      entityId: string
      groupId: string
      contentType: 'terminal' | 'editor' | 'browser' | 'simulator' | 'agent-session'
    }[]
  >
  setActiveTab: ReturnType<typeof vi.fn>
  setActiveFile: ReturnType<typeof vi.fn>
  setActiveBrowserTab: ReturnType<typeof vi.fn>
  activateTab: ReturnType<typeof vi.fn>
  setActiveTabType: ReturnType<typeof vi.fn>
  getActiveTab: (worktreeId: string) => unknown
}

function makeStore(activeTabType: ActiveTabType, overrides: Partial<MockStore> = {}): MockStore {
  const store: MockStore = {
    activeWorktreeId: 'wt-1',
    activeTabType,
    activeTabId: 'term-1',
    activeFileId: 'editor-1',
    activeBrowserTabId: 'browser-1',
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    groupsByWorktree: { 'wt-1': [{ id: 'group-1', activeTabId: 'tab-1' }] },
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    setActiveTab: vi.fn(),
    setActiveFile: vi.fn(),
    setActiveBrowserTab: vi.fn(),
    activateTab: vi.fn(),
    setActiveTabType: vi.fn(),
    getActiveTab: () => null,
    ...overrides
  }
  // Use the real resolver so group selection is exercised instead of supplied by a stub.
  store.getActiveTab = createTabsFocusActions(
    (() => {}) as unknown as TabsSliceSet,
    (() => store) as unknown as TabsSliceGet
  ).getActiveTab
  return store
}

describe('handleSwitchTerminalTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false when no terminal tabs exist', () => {
    const store = makeStore('editor')
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'editor', id: 'editor-1' },
      { type: 'browser', id: 'browser-1' }
    ])

    expect(handleSwitchTerminalTab(1)).toBe(false)
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.setActiveTabType).not.toHaveBeenCalled()
  })

  it('falls back to the worktree terminal order when the active group is still empty', () => {
    const store = makeStore('terminal')
    store.activeTabId = 'term-1'
    store.tabsByWorktree = {
      'wt-1': [{ id: 'term-1' }, { id: 'term-2' }]
    }
    getStateMock.mockReturnValue(store)
    // Keyboard-only worktree activation can briefly restore the group before its unified tabs.
    getActiveTabNavOrderMock.mockReturnValue([])

    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-2')
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal', 'wt-1')
  })

  it('falls back when one stale group terminal hides the remaining worktree terminal', () => {
    const store = makeStore('terminal')
    store.activeTabId = 'term-1'
    store.tabsByWorktree = {
      'wt-1': [{ id: 'term-1' }, { id: 'term-2' }]
    }
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([{ type: 'terminal', id: 'term-1' }])

    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-2')
  })

  it('keeps chats in visible order while still reaching a terminal without its unified row', () => {
    const store = makeStore('agent-session', {
      tabsByWorktree: { 'wt-1': [{ id: 'term-1' }, { id: 'term-2' }] },
      groupsByWorktree: {
        'wt-1': [
          { id: 'group-1', activeTabId: 'chat-tab', tabOrder: ['tab-1', 'chat-tab'] },
          { id: 'group-2', activeTabId: 'other-chat', tabOrder: ['other-chat'] }
        ]
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          { id: 'tab-1', entityId: 'term-1', groupId: 'group-1', contentType: 'terminal' },
          { id: 'chat-tab', entityId: 'chat', groupId: 'group-1', contentType: 'agent-session' },
          { id: 'other-chat', entityId: 'other', groupId: 'group-2', contentType: 'agent-session' }
        ]
      }
    })
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1', tabId: 'tab-1' },
      { type: 'agent-session', id: 'chat', tabId: 'chat-tab' }
    ])
    store.setActiveTab.mockImplementation((id: string) => {
      store.activeTabId = id
    })
    store.setActiveTabType.mockImplementation((type: ActiveTabType) => {
      store.activeTabType = type
    })
    store.activateTab.mockImplementation((tabId: string) => {
      store.groupsByWorktree['wt-1'][0].activeTabId = tabId
    })
    for (const [direction, expectedId, expectedType] of [
      [1, 'term-2', 'terminal'],
      [1, 'term-1', 'terminal'],
      [1, 'chat-tab', 'agent-session'],
      [-1, 'term-1', 'terminal'],
      [-1, 'term-2', 'terminal'],
      [-1, 'chat-tab', 'agent-session']
    ] as const) {
      expect(handleSwitchTerminalTab(direction)).toBe(true)
      if (expectedType === 'agent-session') {
        expect(store.activateTab).toHaveBeenLastCalledWith(expectedId)
      } else {
        expect(store.setActiveTab).toHaveBeenLastCalledWith(expectedId)
      }
      expect(store.activeTabType).toBe(expectedType)
    }
  })

  it('keeps a genuine one-terminal split group a no-op', () => {
    const store = makeStore('terminal')
    store.activeTabId = 'term-1'
    store.tabsByWorktree = {
      'wt-1': [{ id: 'term-1' }, { id: 'term-2' }]
    }
    store.groupsByWorktree = {
      'wt-1': [
        { id: 'group-1', activeTabId: 'tab-1', tabOrder: ['tab-1'] },
        { id: 'group-2', activeTabId: 'tab-2', tabOrder: ['tab-2'] }
      ]
    }
    store.unifiedTabsByWorktree = {
      'wt-1': [
        { id: 'tab-1', entityId: 'term-1', groupId: 'group-1', contentType: 'terminal' },
        { id: 'tab-2', entityId: 'term-2', groupId: 'group-2', contentType: 'terminal' }
      ]
    }
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([{ type: 'terminal', id: 'term-1', tabId: 'tab-1' }])

    expect(handleSwitchTerminalTab(1)).toBe(false)
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.setActiveTabType).not.toHaveBeenCalled()
  })

  it('keeps an editor-only active group local when terminals belong to another split', () => {
    const store = makeStore('editor')
    store.activeFileId = 'editor-1'
    store.tabsByWorktree = {
      'wt-1': [{ id: 'term-2' }]
    }
    store.groupsByWorktree = {
      'wt-1': [
        { id: 'group-1', activeTabId: 'editor-tab', tabOrder: ['editor-tab'] },
        { id: 'group-2', activeTabId: 'terminal-tab', tabOrder: ['terminal-tab'] }
      ]
    }
    store.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: 'editor-tab',
          entityId: 'editor-1',
          groupId: 'group-1',
          contentType: 'editor'
        },
        {
          id: 'terminal-tab',
          entityId: 'term-2',
          groupId: 'group-2',
          contentType: 'terminal'
        }
      ]
    }
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'editor', id: 'editor-1', tabId: 'editor-tab' }
    ])

    expect(handleSwitchTerminalTab(1)).toBe(false)
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.setActiveTabType).not.toHaveBeenCalled()
  })
})

describe('handleSwitchTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('cycles terminal tabs without jumping to editor or browser tabs', () => {
    const store = makeStore('terminal')
    store.activeTabId = 'term-1'
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'file-1', tabId: 'tab-editor-1' },
      { type: 'browser', id: 'browser-1', tabId: 'tab-browser-1' },
      { type: 'terminal', id: 'term-2', tabId: 'tab-terminal-2' }
    ])

    expect(handleSwitchTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-2')
    expect(store.activateTab).toHaveBeenCalledWith('tab-terminal-2')
    expect(store.setActiveFile).not.toHaveBeenCalled()
    expect(store.setActiveBrowserTab).not.toHaveBeenCalled()
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal', 'wt-1')
  })

  it('cycles editor tabs using the active group tab id', () => {
    const store = makeStore('editor')
    store.activeFileId = 'file-a'
    store.activeGroupIdByWorktree = { 'wt-1': 'group-1' }
    store.groupsByWorktree = { 'wt-1': [{ id: 'group-1', activeTabId: 'tab-b' }] }
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'editor', id: 'file-a', tabId: 'tab-a' },
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'file-a', tabId: 'tab-b' },
      { type: 'browser', id: 'browser-1', tabId: 'tab-browser-1' },
      { type: 'editor', id: 'file-c', tabId: 'tab-c' }
    ])

    expect(handleSwitchTab(1)).toBe(true)
    expect(store.setActiveFile).toHaveBeenCalledWith('file-c')
    expect(store.activateTab).toHaveBeenCalledWith('tab-c')
    expect(store.setActiveTabType).toHaveBeenCalledWith('editor', 'wt-1')
  })

  it('cycles browser tabs without jumping to other tab types', () => {
    const store = makeStore('browser')
    store.activeBrowserTabId = 'browser-1'
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'editor-1', tabId: 'tab-editor-1' },
      { type: 'browser', id: 'browser-1', tabId: 'tab-browser-1' },
      { type: 'browser', id: 'browser-2', tabId: 'tab-browser-2' },
      { type: 'terminal', id: 'term-2' }
    ])

    expect(handleSwitchTab(1)).toBe(true)
    expect(store.setActiveBrowserTab).toHaveBeenCalledWith('browser-2')
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.setActiveFile).not.toHaveBeenCalled()
    expect(store.setActiveTabType).toHaveBeenCalledWith('browser', 'wt-1')
  })

  it('falls back when an editor entry has no unified tab id', () => {
    const store = makeStore('editor')
    store.activeFileId = 'file-1'
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'file-1' },
      { type: 'editor', id: 'file-2' }
    ])

    expect(() => handleSwitchTab(1)).not.toThrow()
    expect(store.setActiveFile).toHaveBeenCalledWith('file-2')
    expect(store.activateTab).not.toHaveBeenCalled()
    expect(store.setActiveTabType).toHaveBeenCalledWith('editor', 'wt-1')
  })
})

describe('handleSwitchTabAcrossAllTypes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('crosses tab types, e.g. terminal → editor', () => {
    const store = makeStore('terminal')
    store.activeTabId = 'term-1'
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'file-1', tabId: 'tab-file-1' },
      { type: 'browser', id: 'browser-1', tabId: 'tab-browser-1' }
    ])

    expect(handleSwitchTabAcrossAllTypes(1)).toBe(true)
    expect(store.setActiveFile).toHaveBeenCalledWith('file-1')
    expect(store.activateTab).toHaveBeenCalledWith('tab-file-1')
    expect(store.setActiveTabType).toHaveBeenCalledWith('editor', 'wt-1')
  })

  it('wraps around across types', () => {
    const store = makeStore('browser')
    store.activeBrowserTabId = 'browser-1'
    store.activeGroupIdByWorktree = {}
    store.groupsByWorktree = {}
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'file-1', tabId: 'tab-file-1' },
      { type: 'browser', id: 'browser-1', tabId: 'tab-browser-1' }
    ])

    expect(handleSwitchTabAcrossAllTypes(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-1')
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal', 'wt-1')
  })
})

describe('degenerate active-group projection recovery (#36313)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Hydration-gap state from #36313: the runtime holds two terminals while the active group's
  // projection lost the left tab's row, so the visible nav order carries only the right tab.
  function makeDegenerateStore(): MockStore {
    const store = makeStore('terminal')
    store.activeTabId = 'term-2'
    store.tabsByWorktree = {
      'wt-1': [{ id: 'term-1' }, { id: 'term-2' }]
    }
    store.groupsByWorktree = {
      'wt-1': [{ id: 'group-1', activeTabId: 'tab-2', tabOrder: ['tab-2'] }]
    }
    store.unifiedTabsByWorktree = {
      'wt-1': [{ id: 'tab-2', entityId: 'term-2', groupId: 'group-1', contentType: 'terminal' }]
    }
    return store
  }

  it('recovers same-type previous cycling when a hydration gap hides a worktree terminal', () => {
    const store = makeDegenerateStore()
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([{ type: 'terminal', id: 'term-2', tabId: 'tab-2' }])

    expect(handleSwitchTab(-1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-1')
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal', 'wt-1')
  })

  it('recovers all-types previous cycling through the same gap', () => {
    const store = makeDegenerateStore()
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([{ type: 'terminal', id: 'term-2', tabId: 'tab-2' }])

    expect(handleSwitchTabAcrossAllTypes(-1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-1')
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal', 'wt-1')
  })

  it('keeps the recent-tab MRU group-scoped in the same state', () => {
    const store = makeDegenerateStore()
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([{ type: 'terminal', id: 'term-2', tabId: 'tab-2' }])

    expect(handleSwitchRecentTab()).toBe(false)
    expect(store.setActiveTab).not.toHaveBeenCalled()
  })

  it('keeps genuine one-terminal split groups a no-op for same-type cycling', () => {
    const store = makeStore('terminal')
    store.activeTabId = 'term-1'
    store.tabsByWorktree = {
      'wt-1': [{ id: 'term-1' }, { id: 'term-2' }]
    }
    store.groupsByWorktree = {
      'wt-1': [
        { id: 'group-1', activeTabId: 'tab-1', tabOrder: ['tab-1'] },
        { id: 'group-2', activeTabId: 'tab-2', tabOrder: ['tab-2'] }
      ]
    }
    store.unifiedTabsByWorktree = {
      'wt-1': [
        { id: 'tab-1', entityId: 'term-1', groupId: 'group-1', contentType: 'terminal' },
        { id: 'tab-2', entityId: 'term-2', groupId: 'group-2', contentType: 'terminal' }
      ]
    }
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([{ type: 'terminal', id: 'term-1', tabId: 'tab-1' }])

    expect(handleSwitchTab(-1)).toBe(false)
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.setActiveTabType).not.toHaveBeenCalled()
  })
})

describe('handleSwitchRecentTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('quick-toggles to the previously focused tab across tab types', () => {
    const store = makeStore('editor')
    store.activeFileId = 'file-c'
    store.groupsByWorktree = {
      'wt-1': [
        {
          id: 'group-1',
          activeTabId: 'tab-c',
          tabOrder: ['tab-a', 'tab-b', 'tab-c'],
          recentTabIds: ['tab-a', 'tab-b', 'tab-c']
        }
      ]
    }
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'editor', id: 'file-a', tabId: 'tab-a' },
      { type: 'browser', id: 'browser-b', tabId: 'tab-b' },
      { type: 'editor', id: 'file-c', tabId: 'tab-c' }
    ])

    expect(handleSwitchRecentTab()).toBe(true)
    expect(store.setActiveBrowserTab).toHaveBeenCalledWith('browser-b')
    expect(store.activateTab).toHaveBeenCalledWith('tab-b')
    expect(store.setActiveTabType).toHaveBeenCalledWith('browser', 'wt-1')
  })
})
