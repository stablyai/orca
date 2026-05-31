import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'

const mocks = vi.hoisted(() => ({
  activateTab: vi.fn(),
  activateWebRuntimeSessionTab: vi.fn(),
  closeBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  closeFile: vi.fn(),
  closeTab: vi.fn(),
  closeUnifiedTab: vi.fn(),
  createBrowserTab: vi.fn(),
  createEmptySplitGroup: vi.fn(),
  createTab: vi.fn(),
  destroyWorkspaceWebviews: vi.fn(),
  dispatchEvent: vi.fn(),
  dropUnifiedTab: vi.fn(),
  focusGroup: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  openFile: vi.fn(),
  pinFile: vi.fn(),
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
  closeWebRuntimeSessionTab: vi.fn(),
  createWebRuntimeSessionBrowserTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))

vi.mock('../../store/slices/browser-webview-cleanup', () => ({
  destroyWorkspaceWebviews: mocks.destroyWorkspaceWebviews
}))

vi.mock('../../lib/create-untitled-markdown', () => ({
  createUntitledMarkdownFileWithTemplateSelection: vi.fn()
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
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'wt-1': [terminalTab] },
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
    openFile: mocks.openFile,
    pinFile: mocks.pinFile,
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
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('terminal-1')
  })

  it('toggles pane expansion from the split-group tab bar collapse button', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.toggleTerminalPaneExpand('terminal-1')

    expect(mocks.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
    expect(mocks.activateTab).toHaveBeenCalledWith('unified-terminal-1')
    expect(mocks.setActiveTab).toHaveBeenCalledWith('terminal-1')
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('terminal')
    const event = mocks.dispatchEvent.mock.calls[0]?.[0] as CustomEvent<{ tabId: string }>
    expect(event.type).toBe(TOGGLE_TERMINAL_PANE_EXPAND_EVENT)
    expect(event.detail).toEqual({ tabId: 'terminal-1' })
  })
})
