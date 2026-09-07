import type * as ReactModule from 'react'
import { vi } from 'vitest'
import { buildTerminalCreateWindow } from './ipc-events-terminal-create-window-test-fixtures'
import type {
  FocusTerminalListenerPayload,
  ListenerRef,
  RequestTerminalCreateListenerPayload,
  TerminalCreateListenerPayload,
  TerminalCreateSurfacingScenario,
  TerminalCreateSurfacingStore
} from './ipc-events-terminal-create-scenario-types'

// Why: the terminal-create surfacing scenario is one long ordered assertion run;
// its store/window/mock wiring lives here so the assertions stay under budget.
export async function setupTerminalCreateSurfacing(
  isFloatingPanelFocused: () => boolean
): Promise<TerminalCreateSurfacingScenario> {
  const createTab = vi.fn(
    (_worktreeId: string, _groupId?: string, _tabType?: string, options?: { id?: string }) => ({
      id: options?.id ?? 'tab-new'
    })
  )
  const setActiveView = vi.fn()
  const setActiveWorktree = vi.fn()
  const markWorktreeVisited = vi.fn()
  const recordWorktreeVisit = vi.fn()
  const setActiveTabType = vi.fn()
  const setActiveTab = vi.fn()
  const revealWorktreeInSidebar = vi.fn()
  const setTabCustomTitle = vi.fn()
  const queueTabStartupCommand = vi.fn()
  const registerAgentLaunchConfig = vi.fn()
  const clearAgentLaunchConfig = vi.fn()
  const updateTabPtyId = vi.fn()
  const setTabLayout = vi.fn()
  const setTabBarOrder = vi.fn()
  const replyTerminalCreate = vi.fn()
  const dispatchEvent = vi.fn()
  const createFloatingWorkspaceTerminalTab = vi.fn()
  const createWebRuntimeSessionTerminal = vi.fn().mockResolvedValue({
    status: 'failed',
    message: 'The workspace is not connected to a remote Orca host.'
  })
  const focusRuntimeTerminalSurface = vi.fn(() => false)
  const focusTerminalTabSurface = vi.fn()
  const storeState: TerminalCreateSurfacingStore = {
    setUpdateStatus: vi.fn(),
    createTab,
    setActiveView,
    setActiveWorktree,
    markWorktreeVisited,
    recordWorktreeVisit,
    isNavigatingHistory: false,
    setActiveTabType,
    setActiveTab,
    revealWorktreeInSidebar,
    setTabCustomTitle,
    queueTabStartupCommand,
    registerAgentLaunchConfig,
    clearAgentLaunchConfig,
    updateTabPtyId,
    setTabLayout,
    tabsByWorktree: {} as Record<string, { id: string; ptyId?: string | null; title?: string }[]>,
    folderWorkspaces: [],
    projectGroups: [],
    repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: {
      'repo-1': ['wt-1', 'wt-2', 'wt-3', 'wt-4', 'wt-history'].map((id) => ({
        id,
        repoId: 'repo-1'
      }))
    } as Record<string, { id: string; repoId: string }[]>,
    openFiles: [],
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    setTabBarOrder,
    ptyIdsByTabId: {} as Record<string, string[]>,
    terminalLayoutsByTabId: {} as Record<string, unknown>,
    fetchRepos: vi.fn(),
    fetchWorktrees: vi.fn(),
    activeModal: null,
    closeModal: vi.fn(),
    openModal: vi.fn(),
    activeWorktreeId: 'wt-1',
    activeView: 'terminal',
    setActiveRepo: vi.fn(),
    setIsFullScreen: vi.fn(),
    updateBrowserPageState: vi.fn(),
    activeTabType: 'terminal',
    editorFontZoomLevel: 0,
    setEditorFontZoomLevel: vi.fn(),
    setRateLimitsFromPush: vi.fn(),
    setSshConnectionState: vi.fn(),
    setSshTargetLabels: vi.fn(),
    setPortForwards: vi.fn(),
    clearPortForwards: vi.fn(),
    setDetectedPorts: vi.fn(),
    enqueueSshCredentialRequest: vi.fn(),
    removeSshCredentialRequest: vi.fn(),
    clearTabPtyId: vi.fn(),
    settings: {
      terminalFontSize: 13,
      experimentalNativeChat: false,
      openAgentTabsInChatByDefault: false,
      activeRuntimeEnvironmentId: undefined as string | undefined
    }
  }
  updateTabPtyId.mockImplementation((tabId: string, ptyId: string) => {
    storeState.ptyIdsByTabId[tabId] = [
      ...new Set([...(storeState.ptyIdsByTabId[tabId] ?? []), ptyId])
    ]
    for (const tabs of Object.values(storeState.tabsByWorktree)) {
      const tab = tabs.find((candidate) => candidate.id === tabId)
      if (tab) {
        tab.ptyId = ptyId
      }
    }
  })
  setTabLayout.mockImplementation((tabId: string, layout: unknown) => {
    storeState.terminalLayoutsByTabId[tabId] = layout
  })
  const createTerminalListenerRef: ListenerRef<(data: TerminalCreateListenerPayload) => void> = {
    current: null
  }
  const requestTerminalCreateListenerRef: ListenerRef<
    (data: RequestTerminalCreateListenerPayload) => void
  > = { current: null }
  const focusTerminalListenerRef: ListenerRef<(data: FocusTerminalListenerPayload) => void> = {
    current: null
  }
  const newTerminalTabListenerRef: ListenerRef<() => void> = { current: null }

  vi.resetModules()
  vi.unstubAllGlobals()

  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return {
      ...actual,
      useEffect: (effect: () => void | (() => void)) => {
        effect()
      }
    }
  })

  vi.doMock('../store', () => ({
    useAppStore: {
      subscribe: vi.fn(() => () => {}),
      getState: () => storeState
    }
  }))

  vi.doMock('@/lib/ui-zoom', () => ({
    applyUIZoom: vi.fn()
  }))
  vi.doMock('@/lib/worktree-activation', () => ({
    activateAndRevealWorktree: vi.fn(),
    ensureWorktreeHasInitialTerminal: vi.fn()
  }))
  vi.doMock('@/components/sidebar/visible-worktrees', () => ({
    getVisibleWorktreeIds: () => []
  }))
  vi.doMock('@/lib/editor-font-zoom', () => ({
    nextEditorFontZoomLevel: vi.fn(() => 0),
    computeEditorFontSize: vi.fn(() => 13)
  }))
  vi.doMock('@/components/settings/SettingsConstants', () => ({
    zoomLevelToPercent: vi.fn(() => 100),
    ZOOM_MIN: -3,
    ZOOM_MAX: 3
  }))
  vi.doMock('@/lib/zoom-events', () => ({
    dispatchZoomLevelChanged: vi.fn()
  }))
  vi.doMock('@/lib/floating-workspace-terminal-actions', () => ({
    createFloatingWorkspaceTerminalTab,
    isEmptyFloatingWorkspacePanelVisible: () => false,
    isFloatingWorkspacePanelFocused: () => isFloatingPanelFocused()
  }))
  vi.doMock('@/runtime/web-runtime-session', () => ({
    activateWebRuntimeSessionTab: vi.fn(),
    closeWebRuntimeSessionTab: vi.fn(),
    createWebRuntimeSessionBrowserTab: vi.fn().mockResolvedValue(false),
    createWebRuntimeSessionTerminal,
    isWebRuntimeSessionActive: vi.fn(() => false)
  }))
  vi.doMock('@/lib/focus-terminal-tab-surface', () => ({
    focusTerminalTabSurface
  }))
  vi.doMock('@/runtime/sync-runtime-graph', () => ({
    focusRuntimeTerminalSurface
  }))
  vi.doMock('@/lib/activate-tab-and-focus-pane', () => ({
    activateTabAndFocusPane: vi.fn()
  }))
  vi.stubGlobal(
    'window',
    buildTerminalCreateWindow({
      dispatchEvent,
      replyTerminalCreate,
      createTerminalListenerRef,
      requestTerminalCreateListenerRef,
      focusTerminalListenerRef,
      newTerminalTabListenerRef
    })
  )

  const { useIpcEvents: registerIpcEvents } = await import('./useIpcEvents')
  registerIpcEvents()
  await Promise.resolve()

  if (typeof createTerminalListenerRef.current !== 'function') {
    throw new Error('Expected create-terminal listener to be registered')
  }
  if (typeof newTerminalTabListenerRef.current !== 'function') {
    throw new Error('Expected new-terminal-tab listener to be registered')
  }
  return {
    createTab,
    setActiveView,
    setActiveWorktree,
    markWorktreeVisited,
    recordWorktreeVisit,
    setActiveTabType,
    setActiveTab,
    revealWorktreeInSidebar,
    setTabCustomTitle,
    queueTabStartupCommand,
    registerAgentLaunchConfig,
    updateTabPtyId,
    setTabLayout,
    replyTerminalCreate,
    dispatchEvent,
    createFloatingWorkspaceTerminalTab,
    createWebRuntimeSessionTerminal,
    focusRuntimeTerminalSurface,
    focusTerminalTabSurface,
    storeState,
    createTerminalListenerRef,
    requestTerminalCreateListenerRef,
    focusTerminalListenerRef,
    newTerminalTabListenerRef
  }
}
