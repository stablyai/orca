import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  activateWebRuntimeSessionTabMock,
  closeWebRuntimeSessionTabMock,
  createWebRuntimeSessionTerminalMock,
  getStateMock,
  isWebRuntimeSessionActiveMock,
  isWebTerminalSurfaceTabIdMock,
  resolveHostSessionTabIdForWebSessionTabMock
} = vi.hoisted(() => ({
  activateWebRuntimeSessionTabMock: vi.fn(),
  closeWebRuntimeSessionTabMock: vi.fn(),
  createWebRuntimeSessionTerminalMock: vi.fn(),
  getStateMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn(),
  isWebTerminalSurfaceTabIdMock: vi.fn(() => false),
  resolveHostSessionTabIdForWebSessionTabMock: vi.fn<() => string | null>(() => null)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: activateWebRuntimeSessionTabMock,
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock,
  createWebRuntimeSessionTerminal: createWebRuntimeSessionTerminalMock,
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock,
  isWebTerminalSurfaceTabId: isWebTerminalSurfaceTabIdMock
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  resolveHostSessionTabIdForWebSessionTab: resolveHostSessionTabIdForWebSessionTabMock
}))

import {
  closeOtherTerminalTabs,
  closeTerminalTab,
  closeTerminalTabsToRight,
  createNewTerminalTab
} from './terminal-tab-actions'

describe('createNewTerminalTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createWebRuntimeSessionTerminalMock.mockResolvedValue(true)
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
  })

  it('creates a local terminal tab outside the paired web runtime', () => {
    const createTab = vi.fn(() => ({ id: 'tab-1' }))
    const setActiveTabType = vi.fn()
    const setTabBarOrder = vi.fn()
    getStateMock
      .mockReturnValueOnce({
        settings: { activeRuntimeEnvironmentId: null },
        createTab,
        setActiveTabType,
        setTabBarOrder
      })
      .mockReturnValueOnce({
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
        openFiles: [],
        tabBarOrderByWorktree: {},
        setTabBarOrder
      })

    createNewTerminalTab('wt-1', 'zsh')

    expect(createTab).toHaveBeenCalledWith('wt-1', undefined, 'zsh')
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(setTabBarOrder).toHaveBeenCalledWith('wt-1', ['tab-1'])
    expect(createWebRuntimeSessionTerminalMock).not.toHaveBeenCalled()
  })

  it('delegates terminal creation to the host runtime in paired web clients', () => {
    const createTab = vi.fn(() => ({ id: 'tab-1' }))
    const setActiveTabType = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      createTab,
      setActiveTabType
    })

    createNewTerminalTab('wt-1', 'pwsh')

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      command: 'pwsh',
      activate: true
    })
    expect(createTab).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
  })
})

describe('closeTerminalTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue(null)
    isWebTerminalSurfaceTabIdMock.mockReturnValue(false)
  })

  it('delegates host-backed terminal closes to the paired runtime', () => {
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab-1')
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      tabsByWorktree: {
        'wt-1': [{ id: 'local-tab-1' }, { id: 'local-tab-2' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'local-tab-1',
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('local-tab-1')

    expect(closeTab).toHaveBeenCalledWith('local-tab-1')
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'host-tab-1',
      environmentId: 'web-runtime'
    })
  })

  it('closes unified-only terminal tabs when tabsByWorktree is missing the row', () => {
    const closeUnifiedTab = vi.fn()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: {},
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-tab-1',
            entityId: 'terminal-entity-1',
            contentType: 'terminal',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            label: 'Claude',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            isPreview: false,
            isPinned: false
          }
        ]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'terminal-entity-1',
      openFiles: [],
      browserTabsByWorktree: {},
      closeTab: vi.fn(),
      closeUnifiedTab,
      setActiveTab: vi.fn(),
      setActiveWorktree: vi.fn()
    })

    closeTerminalTab('terminal-entity-1')

    expect(closeUnifiedTab).toHaveBeenCalledWith('unified-tab-1')
  })

  it('activates the next unified terminal tab when closing the active unified-only tab', () => {
    const closeUnifiedTab = vi.fn()
    const setActiveTab = vi.fn()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: {},
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-tab-1',
            entityId: 'terminal-entity-1',
            contentType: 'terminal',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            label: 'Claude',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            isPreview: false,
            isPinned: false
          },
          {
            id: 'unified-tab-2',
            entityId: 'terminal-entity-2',
            contentType: 'terminal',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            label: 'Terminal',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 0,
            isPreview: false,
            isPinned: false
          }
        ]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'terminal-entity-1',
      openFiles: [],
      browserTabsByWorktree: {},
      closeTab: vi.fn(),
      closeUnifiedTab,
      setActiveTab,
      setActiveWorktree: vi.fn()
    })

    closeTerminalTab('terminal-entity-1')

    expect(setActiveTab).toHaveBeenCalledWith('terminal-entity-2')
    expect(closeUnifiedTab).toHaveBeenCalledWith('unified-tab-1')
  })

  it('closes local-only agent tabs locally when they have no host session binding', () => {
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      tabsByWorktree: {
        'wt-1': [{ id: 'local-agent-tab' }, { id: 'local-tab-2' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'local-agent-tab',
      openFiles: [],
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('local-agent-tab')

    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
    expect(closeTab).toHaveBeenCalledWith('local-agent-tab')
  })
})

describe('closeOtherTerminalTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
  })

  it('delegates other terminal closes to the host runtime in paired web clients', () => {
    const setActiveTab = vi.fn()
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      tabsByWorktree: {
        'wt-1': [{ id: 'keep' }, { id: 'close-a' }, { id: 'close-b' }]
      },
      setActiveTab,
      closeTab
    })

    closeOtherTerminalTabs('keep', 'wt-1')

    expect(setActiveTab).toHaveBeenCalledWith('keep')
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledTimes(2)
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'close-a',
      environmentId: 'web-runtime'
    })
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'close-b',
      environmentId: 'web-runtime'
    })
    expect(closeTab).not.toHaveBeenCalled()
  })
})

describe('closeTerminalTabsToRight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
  })

  it('delegates terminal tabs to the host while still closing local editor tabs to the right', () => {
    const closeTab = vi.fn()
    const closeFile = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock
      .mockReturnValueOnce({
        settings: { activeRuntimeEnvironmentId: 'web-runtime' },
        tabsByWorktree: {
          'wt-1': [{ id: 'term-a' }, { id: 'term-b' }, { id: 'term-c' }]
        },
        openFiles: [{ id: 'file-b', worktreeId: 'wt-1' }],
        tabBarOrderByWorktree: { 'wt-1': ['term-a', 'file-b', 'term-b', 'term-c'] },
        closeTab
      })
      .mockReturnValue({
        closeFile
      })

    closeTerminalTabsToRight('term-a', 'wt-1')

    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledTimes(2)
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'term-b',
      environmentId: 'web-runtime'
    })
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'term-c',
      environmentId: 'web-runtime'
    })
    expect(closeFile).toHaveBeenCalledWith('file-b')
    expect(closeTab).not.toHaveBeenCalled()
  })
})
