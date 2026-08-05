import { vi } from 'vitest'
import type * as ReactModule from 'react'
import type { TerminalPaneLayoutNode } from '../../../shared/types'

export type CreateTerminalRequest = {
  requestId?: string
  worktreeId: string
  command?: string
  title?: string
  ptyId?: string
  activate?: boolean
  presentation?: 'background' | 'focused'
  surfaceOwner?: boolean
  tabId?: string
  leafId?: string
  splitFromLeafId?: string
}

export type RequestTerminalCreateRequest = {
  requestId: string
  worktreeId?: string
  command?: string
  title?: string
  activate?: boolean
  presentation?: 'background' | 'focused'
  surfaceOwner?: boolean
}

export type HarnessTab = { id: string; ptyId?: string | null; title?: string }

export type HarnessStoreState = {
  tabsByWorktree: Record<string, HarnessTab[]>
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId: Record<
    string,
    { root?: TerminalPaneLayoutNode; ptyIdsByLeafId?: Record<string, string> }
  >
  [key: string]: unknown
}

/** Store surface useIpcEvents touches at mount plus the terminal-reveal path. */
export function createHarnessStoreState(
  overrides: Partial<HarnessStoreState> & Pick<HarnessStoreState, 'tabsByWorktree'>
): HarnessStoreState {
  const state: HarnessStoreState = {
    createTab: vi.fn(() => ({ id: 'tab-minted' })),
    setActiveView: vi.fn(),
    setActiveWorktree: vi.fn(),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    isNavigatingHistory: false,
    setActiveTabType: vi.fn(),
    setActiveTab: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    setTabCustomTitle: vi.fn(),
    queueTabStartupCommand: vi.fn(),
    registerAgentLaunchConfig: vi.fn(),
    clearAgentLaunchConfig: vi.fn(),
    updateTabPtyId: vi.fn(),
    setTabLayout: vi.fn(),
    setTabBarOrder: vi.fn(),
    clearTabPtyId: vi.fn(),
    setUpdateStatus: vi.fn(),
    fetchRepos: vi.fn(),
    fetchWorktrees: vi.fn(),
    closeModal: vi.fn(),
    openModal: vi.fn(),
    setActiveRepo: vi.fn(),
    setIsFullScreen: vi.fn(),
    updateBrowserPageState: vi.fn(),
    setEditorFontZoomLevel: vi.fn(),
    setRateLimitsFromPush: vi.fn(),
    setSshConnectionState: vi.fn(),
    setSshTargetLabels: vi.fn(),
    setPortForwards: vi.fn(),
    clearPortForwards: vi.fn(),
    setDetectedPorts: vi.fn(),
    enqueueSshCredentialRequest: vi.fn(),
    removeSshCredentialRequest: vi.fn(),
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    folderWorkspaces: [],
    projectGroups: [],
    repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    openFiles: [],
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeModal: null,
    activeWorktreeId: 'wt-1',
    activeView: 'terminal',
    activeTabType: 'terminal',
    editorFontZoomLevel: 0,
    settings: {
      terminalFontSize: 13,
      experimentalNativeChat: false,
      openAgentTabsInChatByDefault: false,
      activeRuntimeEnvironmentId: undefined
    },
    ...overrides
  }
  if (overrides.setTabLayout === undefined) {
    state.setTabLayout = vi.fn(
      (tabId: string, layout: HarnessStoreState['terminalLayoutsByTabId'][string]) => {
        state.terminalLayoutsByTabId[tabId] = layout
      }
    )
  }
  return state
}

/** Subscription no-ops for every listener useIpcEvents attaches beyond the ones under test. */
function createApiNamespaceStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy(overrides, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => () => {})
  })
}

export type IpcEventsHarness = {
  /** Call inside the test body: useIpcEvents runs its effects eagerly here. */
  useIpcEvents: () => void
  createTerminal: (request: CreateTerminalRequest) => void
  requestTerminalCreate: (request: RequestTerminalCreateRequest) => void
  /** Fires the Help > Send Feedback menu event the hook subscribed to. */
  openFeedback: () => void
  replyTerminalCreate: ReturnType<typeof vi.fn>
}

/**
 * Loads useIpcEvents against a stubbed preload API and returns a driver for the
 * create-terminal IPC, so reveal/adoption behavior is asserted through the hook.
 */
export async function loadIpcEventsHarness(
  storeState: HarnessStoreState
): Promise<IpcEventsHarness> {
  const replyTerminalCreate = vi.fn()
  let createTerminalListener: ((request: CreateTerminalRequest) => void) | null = null
  let requestTerminalCreateListener: ((request: RequestTerminalCreateRequest) => void) | null = null
  let openFeedbackListener: (() => void) | null = null

  vi.resetModules()
  vi.unstubAllGlobals()

  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() }
  })
  vi.doMock('../store', () => ({
    useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => storeState }
  }))
  vi.doMock('@/lib/ui-zoom', () => ({ applyUIZoom: vi.fn() }))
  vi.doMock('@/lib/worktree-activation', () => ({
    activateAndRevealWorktree: vi.fn(),
    ensureWorktreeHasInitialTerminal: vi.fn()
  }))
  vi.doMock('@/components/sidebar/visible-worktrees', () => ({ getVisibleWorktreeIds: () => [] }))
  vi.doMock('@/lib/floating-workspace-terminal-actions', () => ({
    createFloatingWorkspaceTerminalTab: vi.fn(),
    isEmptyFloatingWorkspacePanelVisible: () => false,
    isFloatingWorkspacePanelFocused: () => false
  }))
  vi.doMock('@/runtime/web-runtime-session', () => ({
    activateWebRuntimeSessionTab: vi.fn(),
    closeWebRuntimeSessionTab: vi.fn(),
    createWebRuntimeSessionBrowserTab: vi.fn().mockResolvedValue(false),
    createWebRuntimeSessionTerminal: vi.fn().mockResolvedValue({ status: 'failed', message: '' }),
    isWebRuntimeSessionActive: vi.fn(() => false)
  }))
  vi.doMock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
  vi.doMock('@/runtime/sync-runtime-graph', () => ({
    focusRuntimeTerminalSurface: vi.fn(() => false)
  }))
  vi.doMock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))

  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    api: new Proxy(
      {
        ui: createApiNamespaceStub({
          getZoomLevel: () => 0,
          consumePendingOpenSettings: () => Promise.resolve(false),
          set: vi.fn(),
          replyTabCreate: vi.fn(),
          replyTabClose: vi.fn(),
          replyTabSetProfile: vi.fn(),
          replyTerminalCreate,
          onCreateTerminal: (listener: (request: CreateTerminalRequest) => void) => {
            createTerminalListener = listener
            return () => {}
          },
          onRequestTerminalCreate: (listener: (request: RequestTerminalCreateRequest) => void) => {
            requestTerminalCreateListener = listener
            return () => {}
          },
          onOpenFeedback: (listener: () => void) => {
            openFeedbackListener = listener
            return () => {}
          }
        }),
        rateLimits: {
          get: () => Promise.resolve({ limits: {}, lastUpdatedAt: 0 }),
          onUpdate: () => () => {}
        },
        runtime: {
          getTerminalFitOverrides: () => Promise.resolve([]),
          getTerminalDrivers: () => Promise.resolve([]),
          getBrowserDrivers: () => Promise.resolve([]),
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {},
          onBrowserDriverChanged: () => () => {}
        },
        ssh: {
          listTargets: () => Promise.resolve([]),
          listPortForwards: () => Promise.resolve([]),
          listDetectedPorts: () => Promise.resolve([]),
          listRemovedTargetLabels: () => Promise.resolve([]),
          getState: () => Promise.resolve(null),
          onStateChanged: () => () => {},
          onCredentialRequest: () => () => {},
          onCredentialResolved: () => () => {},
          onPortForwardsChanged: () => () => {},
          onDetectedPortsChanged: () => () => {}
        },
        updater: {
          getStatus: () => Promise.resolve({ state: 'idle' }),
          onStatus: () => () => {},
          onClearDismissal: () => () => {}
        },
        mobile: createApiNamespaceStub({
          consumePendingUnpairedDeviceAuthFailure: () => Promise.resolve(false)
        }),
        remoteWorkspace: createApiNamespaceStub({ clientId: () => Promise.resolve(null) })
      } as Record<string, unknown>,
      { get: (target, prop: string) => target[prop] ?? createApiNamespaceStub() }
    )
  })

  const { useIpcEvents } = await import('./useIpcEvents')
  return {
    useIpcEvents,
    createTerminal: (request) => {
      if (typeof createTerminalListener !== 'function') {
        throw new Error('Expected the create-terminal listener to be registered')
      }
      createTerminalListener(request)
    },
    requestTerminalCreate: (request) => {
      if (typeof requestTerminalCreateListener !== 'function') {
        throw new Error('Expected the request-terminal-create listener to be registered')
      }
      requestTerminalCreateListener(request)
    },
    openFeedback: () => {
      if (typeof openFeedbackListener !== 'function') {
        throw new Error('Expected the open-feedback listener to be registered')
      }
      openFeedbackListener()
    },
    replyTerminalCreate
  }
}
