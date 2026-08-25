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

import {
  handleSwitchRecentTab,
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from './ipc-tab-switch'

type ActiveTabType = 'terminal' | 'editor' | 'browser' | 'simulator'

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
  setActiveTab: ReturnType<typeof vi.fn>
  setActiveFile: ReturnType<typeof vi.fn>
  setActiveBrowserTab: ReturnType<typeof vi.fn>
  activateTab: ReturnType<typeof vi.fn>
  setActiveTabType: ReturnType<typeof vi.fn>
}

function makeStore(activeTabType: ActiveTabType, overrides: Partial<MockStore> = {}): MockStore {
  return {
    activeWorktreeId: 'wt-1',
    activeTabType,
    activeTabId: 'term-1',
    activeFileId: 'editor-1',
    activeBrowserTabId: 'browser-1',
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    groupsByWorktree: { 'wt-1': [{ id: 'group-1', activeTabId: 'tab-1' }] },
    setActiveTab: vi.fn(),
    setActiveFile: vi.fn(),
    setActiveBrowserTab: vi.fn(),
    activateTab: vi.fn(),
    setActiveTabType: vi.fn(),
    ...overrides
  }
}

describe('handleSwitchTerminalTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips non-terminal tabs when switching forward', () => {
    const store = makeStore('terminal')
    store.activeTabId = 'term-2'
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'editor-1' },
      { type: 'terminal', id: 'term-2' },
      { type: 'editor', id: 'editor-2' },
      { type: 'terminal', id: 'term-3' }
    ])

    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-3')
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal')
  })

  it('wraps from the last terminal to the first terminal', () => {
    const store = makeStore('terminal')
    store.activeTabId = 'term-3'
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'editor-1' },
      { type: 'terminal', id: 'term-2' },
      { type: 'browser', id: 'browser-1' },
      { type: 'terminal', id: 'term-3' }
    ])

    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-1')
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal')
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

  it('returns false when only one terminal tab exists', () => {
    const store = makeStore('terminal')
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([{ type: 'terminal', id: 'term-1' }])

    expect(handleSwitchTerminalTab(1)).toBe(false)
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.setActiveTabType).not.toHaveBeenCalled()
  })

  it('jumps to the first terminal when an editor tab is active', () => {
    const store = makeStore('editor')
    store.activeFileId = 'editor-2'
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'editor-1' },
      { type: 'terminal', id: 'term-2' },
      { type: 'editor', id: 'editor-2' },
      { type: 'terminal', id: 'term-3' }
    ])

    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-1')
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal')
  })

  it('jumps from an editor to the only terminal when one terminal exists', () => {
    const store = makeStore('editor')
    store.activeFileId = 'editor-1'
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'editor', id: 'editor-1' },
      { type: 'terminal', id: 'term-1' },
      { type: 'browser', id: 'browser-1' }
    ])

    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-1')
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal')
  })

  it('returns false when the only terminal is already active', () => {
    const store = makeStore('terminal')
    store.activeTabId = 'term-1'
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'editor-1' }
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
      { type: 'terminal', id: 'term-2' }
    ])

    expect(handleSwitchTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-2')
    expect(store.setActiveFile).not.toHaveBeenCalled()
    expect(store.setActiveBrowserTab).not.toHaveBeenCalled()
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal')
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
    expect(store.setActiveTabType).toHaveBeenCalledWith('editor')
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
    expect(store.setActiveTabType).toHaveBeenCalledWith('browser')
  })

  it('returns false when the active type has only one tab', () => {
    const store = makeStore('editor')
    store.activeFileId = 'file-1'
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'editor', id: 'file-1', tabId: 'tab-editor-1' },
      { type: 'terminal', id: 'term-1' },
      { type: 'browser', id: 'browser-1', tabId: 'tab-browser-1' }
    ])

    expect(handleSwitchTab(1)).toBe(false)
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.setActiveFile).not.toHaveBeenCalled()
    expect(store.setActiveTabType).not.toHaveBeenCalled()
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
    expect(store.setActiveTabType).toHaveBeenCalledWith('editor')
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
    expect(store.setActiveTabType).toHaveBeenCalledWith('editor')
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
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal')
  })

  it('returns false when only one tab exists total', () => {
    const store = makeStore('terminal')
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([{ type: 'terminal', id: 'term-1' }])

    expect(handleSwitchTabAcrossAllTypes(1)).toBe(false)
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
    expect(store.setActiveTabType).toHaveBeenCalledWith('browser')
  })

  it('returns false when the MRU stack has no previous visible tab', () => {
    const store = makeStore('terminal')
    store.groupsByWorktree = {
      'wt-1': [
        {
          id: 'group-1',
          activeTabId: 'tab-term-1',
          tabOrder: ['tab-term-1'],
          recentTabIds: ['tab-term-1']
        }
      ]
    }
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1', tabId: 'tab-term-1' }
    ])

    expect(handleSwitchRecentTab()).toBe(false)
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.setActiveTabType).not.toHaveBeenCalled()
  })
})

describe('reconciled group navigation composition', () => {
  it('cycles an omitted live editor across all types but not within terminal type (#16389)', async () => {
    vi.resetModules()
    vi.doUnmock('@/components/tab-bar/group-tab-order')
    const tabSwitch = await import('./ipc-tab-switch')
    const { getActiveTabNavOrder } = await import('@/components/tab-bar/group-tab-order')
    const group = {
      id: 'group-1',
      worktreeId: 'wt-1',
      activeTabId: 'tab-term-2',
      tabOrder: ['tab-term-1', 'tab-term-2']
    }
    const store = {
      ...makeStore('terminal', {
        activeTabId: 'term-2',
        activeFileId: '/repo/omitted.md',
        groupsByWorktree: { 'wt-1': [group] }
      }),
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-term-1',
            entityId: 'term-1',
            groupId: 'group-1',
            contentType: 'terminal'
          },
          {
            id: 'tab-editor',
            entityId: '/repo/omitted.md',
            groupId: 'group-1',
            contentType: 'editor'
          },
          {
            id: 'tab-term-2',
            entityId: 'term-2',
            groupId: 'group-1',
            contentType: 'terminal'
          }
        ]
      },
      tabBarOrderByWorktree: { 'wt-1': [] },
      tabsByWorktree: { 'wt-1': [{ id: 'term-1' }, { id: 'term-2' }] },
      openFiles: [{ id: '/repo/omitted.md', worktreeId: 'wt-1' }],
      browserTabsByWorktree: {}
    }
    getStateMock.mockReturnValue(store)

    expect(vi.isMockFunction(getActiveTabNavOrder)).toBe(false)
    expect(getActiveTabNavOrder(store as never, 'wt-1')).toEqual([
      { type: 'terminal', id: 'term-1', tabId: 'tab-term-1' },
      { type: 'terminal', id: 'term-2', tabId: 'tab-term-2' },
      { type: 'editor', id: '/repo/omitted.md', tabId: 'tab-editor' }
    ])
    expect(tabSwitch.handleSwitchTabAcrossAllTypes(1)).toBe(true)
    expect(store.setActiveFile).toHaveBeenCalledWith('/repo/omitted.md')
    expect(store.activateTab).toHaveBeenCalledWith('tab-editor')

    vi.clearAllMocks()
    store.activeTabId = 'term-1'
    group.activeTabId = 'tab-term-1'
    getStateMock.mockReturnValue(store)
    expect(tabSwitch.handleSwitchTabAcrossAllTypes(-1)).toBe(true)
    expect(store.setActiveFile).toHaveBeenCalledWith('/repo/omitted.md')
    expect(store.activateTab).toHaveBeenCalledWith('tab-editor')

    vi.clearAllMocks()
    getStateMock.mockReturnValue(store)
    expect(tabSwitch.handleSwitchTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-2')
    expect(store.setActiveFile).not.toHaveBeenCalled()
    expect(store.activateTab).not.toHaveBeenCalled()
  })
})
