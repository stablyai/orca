import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

const mocks = vi.hoisted(() => ({
  activateTab: vi.fn(),
  activateWebRuntimeSessionTab: vi.fn(),
  closeBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  closeFile: vi.fn(),
  closeTab: vi.fn(),
  closeUnifiedTab: vi.fn(),
  closeWebRuntimeSessionTab: vi.fn(),
  createBrowserTab: vi.fn(),
  createEmptySplitGroup: vi.fn(),
  createTab: vi.fn(),
  createWebRuntimeSessionBrowserTab: vi.fn(() => Promise.resolve(false)),
  createWebRuntimeSessionTerminal: vi.fn(() => Promise.resolve(false)),
  createUntitledMarkdownFile: vi.fn(),
  getFloatingMarkdownDirectory: vi.fn(),
  pickFloatingMarkdownDocument: vi.fn(),
  destroyWorkspaceWebviews: vi.fn(),
  dispatchEvent: vi.fn(),
  dropUnifiedTab: vi.fn(),
  focusGroup: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  makePreviewFilePermanent: vi.fn(),
  openFile: vi.fn(),
  pinFile: vi.fn(),
  recordFeatureInteraction: vi.fn(),
  requestEditorFileClose: vi.fn(),
  setActiveBrowserTab: vi.fn(),
  setActiveFile: vi.fn(),
  setActiveTab: vi.fn(),
  setActiveTabType: vi.fn(),
  setActiveWorktree: vi.fn(),
  setTabColor: vi.fn(),
  setTabCustomTitle: vi.fn()
}))

const storeBox = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useCallback: <T>(callback: T) => callback,
    useMemo: <T>(factory: () => T) => factory()
  }
})

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T>(selector: T) => selector
}))

vi.mock('../../store', () => {
  const useAppStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeBox.state ?? {}),
    {
      getState: () => storeBox.state ?? {}
    }
  )
  return { useAppStore }
})

vi.mock('../../store/selectors', () => ({
  useAllWorktrees: () => [{ id: 'wt-1', path: '/worktree' }]
}))

vi.mock('../../lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('../../runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: mocks.activateWebRuntimeSessionTab,
  closeWebRuntimeSessionTab: mocks.closeWebRuntimeSessionTab,
  createWebRuntimeSessionBrowserTab: mocks.createWebRuntimeSessionBrowserTab,
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive,
  toHostSessionTabId: (tabId: string) => tabId
}))

vi.mock('../../store/slices/browser-webview-cleanup', () => ({
  destroyWorkspaceWebviews: mocks.destroyWorkspaceWebviews
}))

vi.mock('../../lib/create-untitled-markdown', () => ({
  createUntitledMarkdownFileWithTemplateSelection: mocks.createUntitledMarkdownFile
}))

vi.mock('../../lib/connection-context', () => ({
  getConnectionId: () => null
}))

vi.mock('../editor/editor-autosave', () => ({
  requestEditorFileClose: mocks.requestEditorFileClose
}))

vi.mock('../../lib/ipc-error', () => ({
  extractIpcErrorMessage: (_error: unknown, fallback: string) => fallback
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

function resetStore(): void {
  const terminalTab = {
    id: 'terminal-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    defaultTitle: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const unifiedTab = {
    id: 'unified-terminal-1',
    entityId: terminalTab.id,
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'terminal',
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  storeBox.state = {
    activeWorktreeId: 'wt-1',
    browserTabsByWorktree: {},
    expandedPaneByTabId: {},
    groupsByWorktree: {
      'wt-1': [
        {
          id: 'group-1',
          worktreeId: 'wt-1',
          activeTabId: unifiedTab.id,
          tabOrder: [unifiedTab.id]
        }
      ]
    },
    openFiles: [],
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'wt-1': [terminalTab] },
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: { 'wt-1': [unifiedTab] },
    activateTab: mocks.activateTab,
    closeBrowserTab: mocks.closeBrowserTab,
    closeEmptyGroup: mocks.closeEmptyGroup,
    closeFile: mocks.closeFile,
    closeTab: mocks.closeTab,
    closeUnifiedTab: mocks.closeUnifiedTab,
    createBrowserTab: mocks.createBrowserTab,
    createEmptySplitGroup: mocks.createEmptySplitGroup,
    createTab: mocks.createTab,
    dropUnifiedTab: mocks.dropUnifiedTab,
    focusGroup: mocks.focusGroup,
    makePreviewFilePermanent: mocks.makePreviewFilePermanent,
    openFile: mocks.openFile,
    pinFile: mocks.pinFile,
    recordFeatureInteraction: mocks.recordFeatureInteraction,
    setActiveBrowserTab: mocks.setActiveBrowserTab,
    setActiveFile: mocks.setActiveFile,
    setActiveTab: mocks.setActiveTab,
    setActiveTabType: mocks.setActiveTabType,
    setActiveWorktree: mocks.setActiveWorktree,
    setTabColor: mocks.setTabColor,
    setTabCustomTitle: mocks.setTabCustomTitle
  }
}

describe('useTabGroupWorkspaceModel terminal activation focus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('window', {
      dispatchEvent: mocks.dispatchEvent
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns keyboard focus to xterm after a terminal tab is activated', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.activateTerminal('terminal-1')

    expect(mocks.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
    expect(mocks.activateTab).toHaveBeenCalledWith('unified-terminal-1')
    expect(mocks.setActiveTab).toHaveBeenCalledWith('terminal-1')
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('terminal', 'wt-1')
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('terminal-1', null)
  })

  it('returns keyboard focus to the active split pane leaf when a terminal tab is activated', async () => {
    storeBox.state = {
      ...storeBox.state,
      terminalLayoutsByTabId: {
        'terminal-1': {
          activeLeafId: 'right-leaf',
          ptyIdsByLeafId: {
            'left-leaf': 'pty-left',
            'right-leaf': 'pty-right'
          },
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'left-leaf' },
            second: { type: 'leaf', leafId: 'right-leaf' }
          },
          expandedLeafId: null
        }
      }
    }
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.activateTerminal('terminal-1')

    expect(mocks.setActiveTabType).toHaveBeenCalledWith('terminal', 'wt-1')
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('terminal-1', 'right-leaf')
  })

  it('toggles pane expansion from the split-group tab bar collapse button', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.toggleTerminalPaneExpand('terminal-1')

    expect(mocks.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
    expect(mocks.activateTab).toHaveBeenCalledWith('unified-terminal-1')
    expect(mocks.setActiveTab).toHaveBeenCalledWith('terminal-1')
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('terminal', 'wt-1')
    const event = mocks.dispatchEvent.mock.calls[0]?.[0] as CustomEvent<{ tabId: string }>
    expect(event.type).toBe(TOGGLE_TERMINAL_PANE_EXPAND_EVENT)
    expect(event.detail).toEqual({ tabId: 'terminal-1' })
  })

  it('revokes local terminal state before paired-host bulk close', async () => {
    const secondTerminal = {
      id: 'terminal-2',
      ptyId: 'remote:env-1@@pty-2',
      worktreeId: 'wt-1',
      title: 'Terminal 2',
      defaultTitle: 'Terminal 2',
      customTitle: null,
      color: null,
      sortOrder: 1,
      createdAt: 1
    }
    const secondUnified = {
      id: 'unified-terminal-2',
      entityId: secondTerminal.id,
      groupId: 'group-1',
      worktreeId: 'wt-1',
      contentType: 'terminal',
      label: 'Terminal 2',
      customLabel: null,
      color: null,
      sortOrder: 1,
      createdAt: 1
    }
    const currentState = storeBox.state as {
      tabsByWorktree: Record<string, unknown[]>
      unifiedTabsByWorktree: Record<string, { id: string }[]>
    }
    const firstUnified = currentState.unifiedTabsByWorktree['wt-1'][0]
    storeBox.state = {
      ...storeBox.state,
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      tabsByWorktree: {
        'wt-1': [...currentState.tabsByWorktree['wt-1'], secondTerminal]
      },
      unifiedTabsByWorktree: {
        'wt-1': [firstUnified, secondUnified]
      },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: firstUnified.id,
            tabOrder: [firstUnified.id, secondUnified.id]
          }
        ]
      }
    }
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.closeOthers(firstUnified.id)

    expect(mocks.closeTab).toHaveBeenCalledWith(
      'terminal-2',
      expect.objectContaining({ remoteCloseOwnedByHost: true })
    )
    expect(mocks.closeWebRuntimeSessionTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'terminal-2',
      environmentId: 'env-1'
    })
  })

  it('records terminal split completion when splitting a single terminal tab group', async () => {
    mocks.createEmptySplitGroup.mockReturnValue('group-2')
    mocks.createTab.mockReturnValue({ id: 'terminal-2' })
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.createSplitGroup('right')

    expect(mocks.createEmptySplitGroup).toHaveBeenCalledWith('wt-1', 'group-1', 'right')
    expect(mocks.createTab).toHaveBeenCalledWith('wt-1', 'group-2')
    expect(mocks.dropUnifiedTab).not.toHaveBeenCalled()
    expect(mocks.recordFeatureInteraction).toHaveBeenCalledWith('terminal-pane-split')
    expect(mocks.setActiveTab).toHaveBeenCalledWith('terminal-2')
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('terminal')
  })

  it('seeds a new terminal instead of moving the active tab when the group has multiple tabs', async () => {
    const secondUnifiedTab = {
      id: 'unified-terminal-2',
      entityId: 'terminal-2',
      groupId: 'group-1',
      worktreeId: 'wt-1',
      contentType: 'terminal',
      label: 'Terminal 2',
      customLabel: null,
      color: null,
      sortOrder: 1,
      createdAt: 1
    }
    storeBox.state = {
      ...storeBox.state,
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: secondUnifiedTab.id,
            tabOrder: ['unified-terminal-1', secondUnifiedTab.id]
          }
        ]
      },
      unifiedTabsByWorktree: {
        'wt-1': [...(storeBox.state?.unifiedTabsByWorktree?.['wt-1'] ?? []), secondUnifiedTab]
      }
    }
    mocks.createEmptySplitGroup.mockReturnValue('group-2')
    mocks.createTab.mockReturnValue({ id: 'terminal-3' })
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.createSplitGroup('right')

    expect(mocks.createEmptySplitGroup).toHaveBeenCalledWith('wt-1', 'group-1', 'right')
    expect(mocks.createTab).toHaveBeenCalledWith('wt-1', 'group-2')
    expect(mocks.dropUnifiedTab).not.toHaveBeenCalled()
    expect(mocks.setActiveTab).toHaveBeenCalledWith('terminal-3')
  })

  it('closes client-local browser fallback tabs locally in remote workspaces', async () => {
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    const browserTab = {
      id: 'browser-workspace-1',
      worktreeId: 'wt-1',
      sessionProfileId: null,
      activePageId: 'browser-page-1',
      pageIds: ['browser-page-1'],
      url: 'about:blank',
      title: 'New Browser Tab',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 1
    }
    storeBox.state = {
      ...storeBox.state,
      browserPagesByWorkspace: {
        'browser-workspace-1': [
          {
            id: 'browser-page-1',
            workspaceId: 'browser-workspace-1',
            worktreeId: 'wt-1',
            url: 'about:blank',
            title: 'New Browser Tab',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1,
            browserRuntimeEnvironmentId: null
          }
        ]
      },
      browserTabsByWorktree: { 'wt-1': [browserTab] },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: 'browser-unified-1',
            tabOrder: ['browser-unified-1']
          }
        ]
      },
      remoteBrowserPageHandlesByPageId: {},
      settings: { activeRuntimeEnvironmentId: 'remote-runtime' },
      tabsByWorktree: { 'wt-1': [] },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'browser-unified-1',
            entityId: 'browser-workspace-1',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'browser',
            label: 'New Browser Tab',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    }
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.closeItem('browser-unified-1')

    expect(mocks.closeWebRuntimeSessionTab).not.toHaveBeenCalled()
    expect(mocks.destroyWorkspaceWebviews).toHaveBeenCalledWith(
      storeBox.state.browserPagesByWorkspace,
      'browser-workspace-1'
    )
    expect(mocks.closeBrowserTab).toHaveBeenCalledWith('browser-workspace-1')
  })

  it('preserves the stored session partition when duplicating a local browser tab', async () => {
    storeBox.state = {
      ...storeBox.state,
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'browser-workspace-1',
            worktreeId: 'wt-1',
            sessionProfileId: 'profile-1',
            sessionPartition: 'persist:orca-browser-session-profile-1',
            activePageId: 'browser-page-1',
            pageIds: ['browser-page-1'],
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      }
    }
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.duplicateBrowserTab('browser-workspace-1')

    expect(mocks.createBrowserTab).toHaveBeenCalledWith('wt-1', 'https://example.com', {
      title: 'Example',
      sessionProfileId: 'profile-1',
      sessionPartition: 'persist:orca-browser-session-profile-1',
      targetGroupId: 'group-1'
    })
  })

  it('closes a host-mirrored browser with an empty page list via the host (no dead-end)', async () => {
    // Regression: a host-owned browser whose local page list was momentarily
    // empty had no remote-owned PAGES, so the close skipped the host RPC and the
    // local close couldn't resolve it — the tab became un-closable. It must now
    // route to the host close AND remove the visible unified tab.
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    storeBox.state = {
      ...storeBox.state,
      // No pages for this workspace — the corrupt/transient state.
      browserPagesByWorkspace: {},
      browserTabsByWorktree: { 'wt-1': [] },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: 'browser-unified-1',
            tabOrder: ['browser-unified-1']
          }
        ]
      },
      remoteBrowserPageHandlesByPageId: {},
      settings: { activeRuntimeEnvironmentId: 'remote-runtime' },
      tabsByWorktree: { 'wt-1': [] },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'browser-unified-1',
            entityId: 'browser-workspace-1',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'browser',
            label: 'New Browser Tab',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    }
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.closeItem('browser-unified-1')

    // Host close fires (idempotent) and the visible unified tab is removed.
    expect(mocks.closeWebRuntimeSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-1', tabId: 'browser-unified-1' })
    )
    expect(mocks.closeUnifiedTab).toHaveBeenCalledWith('browser-unified-1')
  })
})

describe('useTabGroupWorkspaceModel dirty editor bulk closes', () => {
  function makeEditorTab(id: string, sortOrder: number) {
    return {
      id: `tab-${id}`,
      entityId: id,
      groupId: 'group-1',
      worktreeId: 'wt-1',
      contentType: 'editor' as const,
      label: id,
      customLabel: null,
      color: null,
      sortOrder,
      createdAt: sortOrder
    }
  }

  function seedDirtyEditors(): void {
    const tabs = [
      makeEditorTab('file-a', 0),
      makeEditorTab('file-b', 1),
      makeEditorTab('file-c', 2)
    ]
    const state = storeBox.state as Record<string, unknown>
    ;(state.groupsByWorktree as Record<string, unknown>)['wt-1'] = [
      {
        id: 'group-1',
        worktreeId: 'wt-1',
        activeTabId: 'tab-file-b',
        tabOrder: ['tab-file-a', 'tab-file-b', 'tab-file-c']
      }
    ]
    ;(state.unifiedTabsByWorktree as Record<string, unknown>)['wt-1'] = tabs
    state.openFiles = [
      { id: 'file-a', isDirty: true },
      { id: 'file-b', isDirty: true },
      { id: 'file-c', isDirty: true }
    ]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
    seedDirtyEditors()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('window', { dispatchEvent: mocks.dispatchEvent })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes close-others dirty editors through the centralized save queue', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.closeOthers('tab-file-b')

    // Why: dirty siblings must defer to the save dialog (requestEditorFileClose)
    // instead of being force-closed, so the unified tab is not removed yet.
    expect(mocks.requestEditorFileClose).toHaveBeenCalledWith('file-a', 'wt-1')
    expect(mocks.requestEditorFileClose).toHaveBeenCalledWith('file-c', 'wt-1')
    expect(mocks.requestEditorFileClose).not.toHaveBeenCalledWith('file-b', 'wt-1')
    expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('routes close-to-right dirty editors through the centralized save queue', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.closeToRight('tab-file-a')

    expect(mocks.requestEditorFileClose).toHaveBeenCalledWith('file-b', 'wt-1')
    expect(mocks.requestEditorFileClose).toHaveBeenCalledWith('file-c', 'wt-1')
    expect(mocks.requestEditorFileClose).not.toHaveBeenCalledWith('file-a', 'wt-1')
    expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('routes close-all dirty editors through the centralized save queue', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.closeAllEditorTabsInGroup()

    expect(mocks.requestEditorFileClose).toHaveBeenCalledWith('file-a', 'wt-1')
    expect(mocks.requestEditorFileClose).toHaveBeenCalledWith('file-b', 'wt-1')
    expect(mocks.requestEditorFileClose).toHaveBeenCalledWith('file-c', 'wt-1')
    expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  })
})

describe('useTabGroupWorkspaceModel floating worktree commands', () => {
  const FLOATING_GROUP_ID = 'floating-group'

  function seedFloatingWorktree(): void {
    const state = storeBox.state as Record<string, unknown>
    ;(state.groupsByWorktree as Record<string, unknown>)[FLOATING_TERMINAL_WORKTREE_ID] = [
      {
        id: FLOATING_GROUP_ID,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        activeTabId: null,
        tabOrder: []
      }
    ]
    ;(state.unifiedTabsByWorktree as Record<string, unknown>)[FLOATING_TERMINAL_WORKTREE_ID] = []
    ;(state.tabsByWorktree as Record<string, unknown>)[FLOATING_TERMINAL_WORKTREE_ID] = []
    state.openFile = mocks.openFile
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
    seedFloatingWorktree()
    // Why: vi.clearAllMocks() wipes implementations too, so re-seed the async
    // gates to their default "no remote owner" resolution for each test.
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue(false)
    mocks.createWebRuntimeSessionBrowserTab.mockResolvedValue(false)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('window', {
      dispatchEvent: mocks.dispatchEvent,
      api: {
        app: {
          getFloatingMarkdownDirectory: mocks.getFloatingMarkdownDirectory,
          pickFloatingMarkdownDocument: mocks.pickFloatingMarkdownDocument
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  // Why: floating commands fire async IIFEs without returning the promise, so
  // tests flush microtasks instead of awaiting the command result directly.
  it('creates a local floating terminal without consulting the web runtime session', async () => {
    mocks.createTab.mockReturnValue({ id: 'floating-terminal-1' })
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({
      groupId: FLOATING_GROUP_ID,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    model.commands.newTerminalTab()
    await flushMicrotasks()

    expect(mocks.createTab).toHaveBeenCalledWith(FLOATING_TERMINAL_WORKTREE_ID, FLOATING_GROUP_ID)
    expect(mocks.setActiveTab).toHaveBeenCalledWith('floating-terminal-1')
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('terminal', FLOATING_TERMINAL_WORKTREE_ID)
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('floating-terminal-1')
  })

  it('keeps floating terminal creates local while a web runtime session is active', async () => {
    // Why: the floating workspace is a local scratchpad; a focused remote
    // runtime must never own its tabs even when it would accept the create.
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue(true)
    mocks.createTab.mockReturnValue({ id: 'floating-terminal-1' })
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({
      groupId: FLOATING_GROUP_ID,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    model.commands.newTerminalTab()
    await flushMicrotasks()

    expect(mocks.createWebRuntimeSessionTerminal).not.toHaveBeenCalled()
    expect(mocks.createTab).toHaveBeenCalledWith(FLOATING_TERMINAL_WORKTREE_ID, FLOATING_GROUP_ID)
  })

  it('creates a floating markdown file in the floating markdown directory', async () => {
    mocks.getFloatingMarkdownDirectory.mockResolvedValue('/tmp/orca/floating-notes')
    mocks.createUntitledMarkdownFile.mockResolvedValue({
      filePath: '/tmp/orca/floating-notes/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({
      groupId: FLOATING_GROUP_ID,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    await model.commands.newFileTab()
    await flushMicrotasks()

    expect(mocks.createUntitledMarkdownFile).toHaveBeenCalledWith(
      '/tmp/orca/floating-notes',
      FLOATING_TERMINAL_WORKTREE_ID,
      undefined,
      { activeRuntimeEnvironmentId: null }
    )
    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/orca/floating-notes/untitled.md' }),
      expect.objectContaining({
        preview: false,
        targetGroupId: FLOATING_GROUP_ID,
        suppressActiveRuntimeFallback: true
      })
    )
  })

  it('skips markdown creation when no floating markdown directory is available', async () => {
    mocks.getFloatingMarkdownDirectory.mockResolvedValue(null)
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({
      groupId: FLOATING_GROUP_ID,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    await model.commands.newFileTab()
    await flushMicrotasks()

    expect(mocks.createUntitledMarkdownFile).not.toHaveBeenCalled()
    expect(mocks.openFile).not.toHaveBeenCalled()
  })

  it('opens an existing markdown document through the floating picker', async () => {
    mocks.pickFloatingMarkdownDocument.mockResolvedValue({
      filePath: '/tmp/orca/floating-notes/readme.md',
      relativePath: 'readme.md'
    })
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({
      groupId: FLOATING_GROUP_ID,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    await model.commands.openFileTab?.()
    await flushMicrotasks()

    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/orca/floating-notes/readme.md',
        relativePath: 'readme.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        mode: 'edit'
      }),
      expect.objectContaining({
        preview: false,
        targetGroupId: FLOATING_GROUP_ID,
        suppressActiveRuntimeFallback: true
      })
    )
  })

  it('does nothing when the floating markdown picker is dismissed', async () => {
    mocks.pickFloatingMarkdownDocument.mockResolvedValue(null)
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({
      groupId: FLOATING_GROUP_ID,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    await model.commands.openFileTab?.()
    await flushMicrotasks()

    expect(mocks.openFile).not.toHaveBeenCalled()
  })

  it('keeps floating browser creates local while a web runtime session is active', async () => {
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    mocks.createWebRuntimeSessionBrowserTab.mockResolvedValue(true)
    const state = storeBox.state as Record<string, unknown>
    state.browserDefaultUrl = 'https://example.com'
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({
      groupId: FLOATING_GROUP_ID,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    model.commands.newBrowserTab()
    await flushMicrotasks()

    expect(mocks.createWebRuntimeSessionBrowserTab).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'https://example.com',
      expect.objectContaining({
        focusAddressBar: true,
        targetGroupId: FLOATING_GROUP_ID,
        browserRuntimeEnvironmentId: null
      })
    )
  })
})
