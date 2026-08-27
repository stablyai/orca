import type * as ReactModule from 'react'
import { vi } from 'vitest'

export type RequestTabCloseListener = (data: {
  requestId: string
  tabId: string | null
  worktreeId?: string
}) => void
export type CloseActiveTabListener = () => void
export type CloseFloatingItemListener = (payload: { sourceId: string }) => void
export type SelectFloatingIndexListener = (payload: { index: number }) => void
export type CloseTerminalListener = (data: { tabId: string; paneRuntimeId?: number | null }) => void
export type CloseSessionTabListener = (data: { tabId: string; worktreeId: string }) => void
export type SessionTabCloseRequestListener = (data: {
  requestId: string
  tabId: string
  worktreeId: string
  expiresAt?: number
}) => void
export type TerminalTabCloseRequestListener = (data: {
  requestId: string
  tabId: string
  localPtyTeardownOwnedExternally?: boolean
}) => void

export async function useIpcEventsForCloseRouting({
  closeActiveTabListenerRef,
  closeFloatingItemListenerRef,
  selectFloatingIndexListenerRef,
  closeSessionTabListenerRef,
  sessionTabCloseRequestListenerRef,
  respondSessionTabClose = vi.fn(),
  closeTerminalListenerRef,
  getState,
  requestTabCloseListenerRef,
  replyTabClose = vi.fn(),
  terminalTabCloseRequestListenerRef,
  respondTerminalTabClose = vi.fn(),
  persistWorkspaceSession = vi.fn().mockResolvedValue(undefined)
}: {
  closeActiveTabListenerRef?: { current: CloseActiveTabListener | null }
  closeFloatingItemListenerRef?: { current: CloseFloatingItemListener | null }
  selectFloatingIndexListenerRef?: { current: SelectFloatingIndexListener | null }
  closeSessionTabListenerRef?: { current: CloseSessionTabListener | null }
  sessionTabCloseRequestListenerRef?: { current: SessionTabCloseRequestListener | null }
  respondSessionTabClose?: ReturnType<typeof vi.fn>
  closeTerminalListenerRef?: { current: CloseTerminalListener | null }
  getState: () => Record<string, unknown>
  requestTabCloseListenerRef?: { current: RequestTabCloseListener | null }
  replyTabClose?: ReturnType<typeof vi.fn>
  terminalTabCloseRequestListenerRef?: { current: TerminalTabCloseRequestListener | null }
  respondTerminalTabClose?: ReturnType<typeof vi.fn>
  persistWorkspaceSession?: ReturnType<typeof vi.fn>
}): Promise<void> {
  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return {
      ...actual,
      useEffect: (effect: () => void | (() => void)) => {
        effect()
      }
    }
  })

  const appStoreModule = {
    useAppStore: {
      subscribe: vi.fn(() => () => {}),
      getState: () => ({
        setUpdateStatus: vi.fn(),
        fetchRepos: vi.fn(),
        fetchWorktrees: vi.fn(),
        setActiveView: vi.fn(),
        activeModal: null,
        closeModal: vi.fn(),
        openModal: vi.fn(),
        activeWorktreeId: 'wt-1',
        activeView: 'terminal',
        setActiveRepo: vi.fn(),
        setActiveWorktree: vi.fn(),
        revealWorktreeInSidebar: vi.fn(),
        setIsFullScreen: vi.fn(),
        updateBrowserTabPageState: vi.fn(),
        activeTabType: 'browser',
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
        settings: { activeRuntimeEnvironmentId: null, terminalFontSize: 13 },
        activeBrowserTabId: 'workspace-1',
        activeBrowserTabIdByWorktree: { 'wt-1': 'workspace-1' },
        browserTabsByWorktree: { 'wt-1': [{ id: 'workspace-1' }] },
        browserPagesByWorkspace: {},
        openFiles: [],
        unifiedTabsByWorktree: {},
        closeBrowserTab: vi.fn(),
        closeBrowserPage: vi.fn(),
        requestPinnedTabCloseConfirm: vi.fn(),
        ...getState()
      })
    }
  }

  vi.doMock('../store', () => appStoreModule)
  vi.doMock('@/store', () => appStoreModule)

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
  vi.doMock('@/lib/workspace-session-host-persistence', () => ({
    persistWorkspaceSessionByHost: persistWorkspaceSession
  }))
  vi.doMock('@/lib/workspace-session', () => ({
    buildWorkspaceSessionPayload: vi.fn(() => ({}))
  }))

  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    api: {
      repos: { onChanged: () => () => {} },
      automations: { onChanged: () => () => {} },
      worktrees: {
        onChanged: () => () => {},
        onBaseStatus: () => () => {},
        onRemoteBranchConflict: () => () => {}
      },
      ui: {
        onStateChanged: () => () => {},
        onOpenSettings: () => () => {},
        consumePendingOpenSettings: () => Promise.resolve(false),
        onOpenFeatureTour: () => () => {},
        onToggleLeftSidebar: () => () => {},
        onToggleRightSidebar: () => () => {},
        onToggleWorktreePalette: () => () => {},
        onToggleFloatingTerminal: () => () => {},
        onOpenQuickOpen: () => () => {},
        onToggleQuickCommandsMenu: () => () => {},
        onOpenNewWorkspace: () => () => {},
        onOpenTasks: () => () => {},
        onJumpToWorktreeIndex: () => () => {},
        onJumpToTabIndex: () => () => {},
        onWorktreeHistoryNavigate: () => () => {},
        onActivateWorktree: () => () => {},
        onCreateTerminal: () => () => {},
        onRequestTerminalCreate: () => () => {},
        onRequestTerminalTabMount: () => () => {},
        replyTerminalCreate: () => {},
        onSplitTerminal: () => () => {},
        onRenameTerminal: () => () => {},
        onFocusTerminal: () => () => {},
        onFocusEditorTab: () => () => {},
        onCloseSessionTab: (listener: CloseSessionTabListener) => {
          if (closeSessionTabListenerRef) {
            closeSessionTabListenerRef.current = listener
          }
          return () => {}
        },
        onSessionTabCloseRequest: (listener: SessionTabCloseRequestListener) => {
          if (sessionTabCloseRequestListenerRef) {
            sessionTabCloseRequestListenerRef.current = listener
          }
          return () => {}
        },
        respondSessionTabClose,
        onMoveSessionTab: () => () => {},
        onOpenFileFromMobile: () => () => {},
        onOpenDiffFromMobile: () => () => {},
        onCloseTerminal: (listener: CloseTerminalListener) => {
          if (closeTerminalListenerRef) {
            closeTerminalListenerRef.current = listener
          }
          return () => {}
        },
        onTerminalTabCloseRequest: (listener: TerminalTabCloseRequestListener) => {
          if (terminalTabCloseRequestListenerRef) {
            terminalTabCloseRequestListenerRef.current = listener
          }
          return () => {}
        },
        respondTerminalTabClose,
        onSleepWorktree: () => () => {},
        onResumeSleepingAgents: () => () => {},
        onNewBrowserTab: () => () => {},
        onNewMarkdownTab: () => () => {},
        onRequestTabCreate: () => () => {},
        replyTabCreate: () => {},
        onRequestTabClose: (listener: RequestTabCloseListener) => {
          if (requestTabCloseListenerRef) {
            requestTabCloseListenerRef.current = listener
          }
          return () => {}
        },
        replyTabClose,
        onRequestTabSetProfile: () => () => {},
        replyTabSetProfile: () => {},
        onNewTerminalTab: () => () => {},
        onCloseActiveTab: (listener: CloseActiveTabListener) => {
          if (closeActiveTabListenerRef) {
            closeActiveTabListenerRef.current = listener
          }
          return () => {}
        },
        onCloseFloatingItem: (listener: CloseFloatingItemListener) => {
          if (closeFloatingItemListenerRef) {
            closeFloatingItemListenerRef.current = listener
          }
          return () => {}
        },
        onSelectFloatingIndex: (listener: SelectFloatingIndexListener) => {
          if (selectFloatingIndexListenerRef) {
            selectFloatingIndexListenerRef.current = listener
          }
          return () => {}
        },
        onSwitchTab: () => () => {},
        onSwitchTabAcrossAllTypes: () => () => {},
        onSwitchRecentTab: () => () => {},
        onSwitchTerminalTab: () => () => {},
        onToggleStatusBar: () => () => {},
        onFullscreenChanged: () => () => {},
        onTerminalZoom: () => () => {},
        getZoomLevel: () => 0,
        set: vi.fn()
      },
      settings: {
        onChanged: () => () => {}
      },
      updater: {
        getStatus: () => Promise.resolve({ state: 'idle' }),
        onStatus: () => () => {},
        onClearDismissal: () => () => {}
      },
      browser: {
        onGuestLoadFailed: () => () => {},
        onOpenLinkInOrcaTab: () => () => {},
        onNavigationUpdate: () => () => {},
        onActivateView: () => () => {},
        onPaneFocus: () => () => {}
      },
      rateLimits: {
        get: () => Promise.resolve({ limits: {}, lastUpdatedAt: Date.now() }),
        onUpdate: () => () => {}
      },
      ssh: {
        listTargets: () => Promise.resolve([]),
        listPortForwards: () => Promise.resolve([]),
        listDetectedPorts: () => Promise.resolve([]),
        getState: () => Promise.resolve(null),
        onStateChanged: () => () => {},
        onCredentialRequest: () => () => {},
        onPortForwardsChanged: () => () => {},
        onDetectedPortsChanged: () => () => {},
        onCredentialResolved: () => () => {}
      },
      runtime: {
        getTerminalFitOverrides: () => Promise.resolve([]),
        getTerminalDrivers: () => Promise.resolve([]),
        getBrowserDrivers: () => Promise.resolve([]),
        onTerminalFitOverrideChanged: () => () => {},
        onTerminalDriverChanged: () => () => {},
        onBrowserDriverChanged: () => {},
        onClientHostedBrowserRowsChanged: () => {},
        getClientHostedBrowserRows: async () => []
      },
      agentStatus: { onSet: () => () => {} }
    }
  })

  const { useIpcEvents: registerIpcEvents } = await import('./useIpcEvents')
  registerIpcEvents()
}
