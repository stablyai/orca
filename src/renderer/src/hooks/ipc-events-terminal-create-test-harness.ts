import type * as ReactModule from 'react'
import { vi } from 'vitest'
import type { AppState } from '@/store/types'
import { buildTerminalCreateWindow } from './ipc-events-terminal-create-window-test-fixtures'
import type {
  FocusTerminalListenerPayload,
  ListenerRef,
  RequestTerminalCreateListenerPayload,
  TerminalCreateListenerPayload,
  TerminalCreateSurfacingScenario
} from './ipc-events-terminal-create-scenario-types'

// Keep ordered scenario assertions in the spec while extracting its store/window wiring to meet the line budget.
export async function setupTerminalCreateSurfacing(
  isFloatingPanelFocused: () => boolean
): Promise<TerminalCreateSurfacingScenario> {
  vi.resetModules()
  vi.unstubAllGlobals()
  const { createTestStore, makeTab, makeWorktree, TEST_REPO } =
    await import('@/store/slices/store-test-helpers')
  const { getDefaultSettings } = await import('../../../shared/constants')
  const store = createTestStore()
  const createTab = vi.fn(
    (_worktreeId: string, _groupId?: string, _tabType?: string, options?: { id?: string }) => ({
      ...makeTab({ id: options?.id ?? 'tab-new', worktreeId: _worktreeId })
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
  const setTabLayout = vi.fn<AppState['setTabLayout']>()
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
  const storeState = {
    ...store.getState(),
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
    tabsByWorktree: store.getState().tabsByWorktree,
    folderWorkspaces: [],
    sleepingAgentSessionsByPaneKey: {},
    projectGroups: [],
    repos: [{ ...TEST_REPO, id: 'repo-1', connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: {
      'repo-1': ['wt-1', 'wt-2', 'wt-3', 'wt-4', 'wt-history'].map((id) =>
        makeWorktree({ id, repoId: 'repo-1' })
      )
    },
    openFiles: [],
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    setTabBarOrder,
    ptyIdsByTabId: store.getState().ptyIdsByTabId,
    terminalLayoutsByTabId: store.getState().terminalLayoutsByTabId,
    fetchRepos: vi.fn(),
    fetchWorktrees: vi.fn(),
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
    setUnrestoredPortForwards: vi.fn(),
    clearPortForwards: vi.fn(),
    setDetectedPorts: vi.fn(),
    enqueueSshCredentialRequest: vi.fn(),
    removeSshCredentialRequest: vi.fn(),
    clearTabPtyId: vi.fn(),
    settings: {
      ...getDefaultSettings('/tmp'),
      terminalFontSize: 13,
      experimentalNativeChat: false,
      activeRuntimeEnvironmentId: undefined as string | undefined
    }
  } satisfies AppState
  store.setState(storeState, true)
  updateTabPtyId.mockImplementation((tabId: string, ptyId: string) => {
    store.getState().ptyIdsByTabId[tabId] = [
      ...new Set([...(store.getState().ptyIdsByTabId[tabId] ?? []), ptyId])
    ]
    for (const tabs of Object.values(store.getState().tabsByWorktree)) {
      const tab = tabs.find((candidate) => candidate.id === tabId)
      if (tab) {
        tab.ptyId = ptyId
      }
    }
  })
  setTabLayout.mockImplementation((tabId, layout) => {
    if (layout) {
      store.getState().terminalLayoutsByTabId[tabId] = layout
    } else {
      delete store.getState().terminalLayoutsByTabId[tabId]
    }
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

  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return {
      ...actual,
      useEffect: (effect: () => void | (() => void)) => {
        effect()
      }
    }
  })

  vi.doMock('../store', () => ({ useAppStore: store }))

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
    isFloatingWorkspacePanelFocused: () => isFloatingPanelFocused()
  }))
  vi.doMock('@/runtime/web-runtime-session-tab-lifecycle', () => ({
    activateWebRuntimeSessionTab: vi.fn(),
    closeWebRuntimeSessionTab: vi.fn()
  }))
  vi.doMock('@/runtime/web-runtime-browser-creation', () => ({
    createWebRuntimeSessionBrowserTab: vi.fn().mockResolvedValue(false)
  }))
  vi.doMock('@/runtime/web-runtime-terminal-creation', () => ({ createWebRuntimeSessionTerminal }))
  vi.doMock('@/runtime/web-runtime-session-environment', () => ({
    isWebRuntimeSessionActive: vi.fn(() => false)
  }))
  vi.doMock('@/lib/focus-terminal-tab-surface', () => ({
    focusTerminalTabSurface
  }))
  vi.doMock('@/runtime/mounted-terminal-tab-registry', () => ({
    focusRuntimeTerminalSurface,
    subscribeMountedTerminalTabChanges: vi.fn(() => () => {})
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
      focusTerminalListenerRef
    })
  )

  const { useIpcEvents: registerIpcEvents } = await import('./useIpcEvents')
  registerIpcEvents()
  await Promise.resolve()

  if (typeof createTerminalListenerRef.current !== 'function') {
    throw new Error('Expected create-terminal listener to be registered')
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
    get storeState() {
      return store.getState()
    },
    createTerminalListenerRef,
    requestTerminalCreateListenerRef,
    focusTerminalListenerRef
  }
}
