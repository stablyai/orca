import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  activateWebRuntimeSessionTabMock,
  closeWebRuntimeSessionTabMock,
  createWebRuntimeSessionTerminalMock,
  getStateMock,
  isWebRuntimeSessionActiveMock,
  isWebTerminalSurfaceTabIdMock,
  resolveHostSessionTabIdForWebSessionTabMock,
  toHostSessionTabIdMock
} = vi.hoisted(() => ({
  activateWebRuntimeSessionTabMock: vi.fn(),
  closeWebRuntimeSessionTabMock: vi.fn(),
  createWebRuntimeSessionTerminalMock: vi.fn(),
  getStateMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn(),
  isWebTerminalSurfaceTabIdMock: vi.fn(() => false),
  resolveHostSessionTabIdForWebSessionTabMock: vi.fn<() => string | null>(() => null),
  toHostSessionTabIdMock: vi.fn((tabId: string) => tabId)
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
  isWebTerminalSurfaceTabId: isWebTerminalSurfaceTabIdMock,
  toHostSessionTabId: toHostSessionTabIdMock
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

    expect(createTab).toHaveBeenCalledWith('wt-1', undefined, 'zsh', undefined)
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
      environmentId: 'web-runtime',
      command: 'pwsh',
      activate: true
    })
    expect(createTab).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
  })

  it('delegates terminal creation to the explicit owner runtime when another runtime is focused', () => {
    const createTab = vi.fn(() => ({ id: 'tab-1' }))
    const setActiveTabType = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      repos: [{ id: 'repo-1', executionHostId: 'runtime:owner-runtime', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      createTab,
      setActiveTabType
    })

    createNewTerminalTab('wt-1', 'pwsh')

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'owner-runtime',
      command: 'pwsh',
      activate: true
    })
    expect(createTab).not.toHaveBeenCalled()
  })

  it('creates local terminal tabs with a requested startup cwd', () => {
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

    createNewTerminalTab('wt-1', undefined, { startupCwd: '/repo/packages/app' })

    expect(createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      startupCwd: '/repo/packages/app'
    })
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')
  })

  it('delegates requested startup cwd to host runtime terminals', () => {
    const createTab = vi.fn(() => ({ id: 'tab-1' }))
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      createTab,
      setActiveTabType: vi.fn()
    })

    createNewTerminalTab('wt-1', undefined, { startupCwd: '/repo/packages/app' })

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      command: undefined,
      cwd: '/repo/packages/app',
      activate: true
    })
    expect(createTab).not.toHaveBeenCalled()
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

    expect(closeTab).toHaveBeenCalledWith('local-tab-1', {
      reason: undefined,
      remoteCloseOwnedByHost: true
    })
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'host-tab-1',
      environmentId: 'web-runtime'
    })
  })

  it('closes unified-only terminal tabs when tabsByWorktree is missing the row', () => {
    const closeTab = vi.fn()
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
      closeTab,
      closeUnifiedTab,
      setActiveTab: vi.fn(),
      setActiveWorktree: vi.fn()
    })

    closeTerminalTab('terminal-entity-1')

    expect(closeTab).toHaveBeenCalledWith('terminal-entity-1', { reason: undefined })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('activates the next unified terminal tab when closing the active unified-only tab', () => {
    const closeTab = vi.fn()
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
      closeTab,
      closeUnifiedTab,
      setActiveTab,
      setActiveWorktree: vi.fn()
    })

    closeTerminalTab('terminal-entity-1')

    expect(setActiveTab).toHaveBeenCalledWith('terminal-entity-2')
    expect(closeTab).toHaveBeenCalledWith('terminal-entity-1', { reason: undefined })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('routes closes on a remote worktree to the host even when the local→host map has no entry', () => {
    // Why: regression for the close-reappear bug. On a remote-owned worktree the
    // tab is host-authoritative; when the map has no entry (e.g. a plain-UUID host
    // tab id) the close must still reach the host via the decoded id, or the
    // host's next snapshot re-adds the tab. It also prunes locally for snappiness.
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue(null)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      tabsByWorktree: {
        'wt-1': [{ id: 'plain-uuid-tab' }, { id: 'local-tab-2' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'plain-uuid-tab',
      openFiles: [],
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('plain-uuid-tab')

    expect(closeTab).toHaveBeenCalledWith('plain-uuid-tab', {
      reason: undefined,
      remoteCloseOwnedByHost: true
    })
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'plain-uuid-tab',
      environmentId: 'web-runtime'
    })
  })

  function makePinnedTabState(
    overrides: { confirmClosePinnedTab: boolean } & Record<string, unknown>
  ): Record<string, unknown> {
    const { confirmClosePinnedTab, ...rest } = overrides
    return {
      settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab },
      tabsByWorktree: {},
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-pinned-1',
            entityId: 'pinned-entity-1',
            contentType: 'terminal',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            label: 'Server',
            generatedLabel: null,
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            isPreview: false,
            isPinned: true
          }
        ]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'pinned-entity-1',
      openFiles: [],
      browserTabsByWorktree: {},
      closeTab: vi.fn(),
      closeUnifiedTab: vi.fn(),
      setActiveTab: vi.fn(),
      setActiveWorktree: vi.fn(),
      requestPinnedTabCloseConfirm: vi.fn(),
      ...rest
    }
  }

  it('routes a pinned tab through the confirmation guard instead of closing it', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeUnifiedTab = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: true,
        requestPinnedTabCloseConfirm,
        closeUnifiedTab
      })
    )

    closeTerminalTab('pinned-entity-1')

    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ tabLabel: 'Server', onConfirm: expect.any(Function) })
    )
  })

  it('closes the pinned tab when the confirmation callback runs', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeTab = vi.fn()
    const closeUnifiedTab = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: true,
        requestPinnedTabCloseConfirm,
        closeTab,
        closeUnifiedTab
      })
    )

    closeTerminalTab('pinned-entity-1')
    const { onConfirm } = requestPinnedTabCloseConfirm.mock.calls[0][0] as { onConfirm: () => void }
    onConfirm()

    expect(closeTab).toHaveBeenCalledWith('pinned-entity-1', { reason: undefined })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('guards a pinned tab closed by its unified id (workspace overlay path)', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeUnifiedTab = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: true,
        requestPinnedTabCloseConfirm,
        closeUnifiedTab
      })
    )

    // Why: TerminalPaneOverlayLayer closes by terminalTab.id (the unified id),
    // not the entityId. The guard must still recognize it as pinned.
    closeTerminalTab('unified-pinned-1')

    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
  })

  it('closes a pinned tab immediately when the confirmation setting is off', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeTab = vi.fn()
    const closeUnifiedTab = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: false,
        requestPinnedTabCloseConfirm,
        closeTab,
        closeUnifiedTab
      })
    )

    closeTerminalTab('pinned-entity-1')

    expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
    expect(closeTab).toHaveBeenCalledWith('pinned-entity-1', { reason: undefined })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
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
