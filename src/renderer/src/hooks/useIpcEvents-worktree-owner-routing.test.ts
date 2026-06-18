import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { closeTerminalTabMock, activateAndRevealWorktreeMock } = vi.hoisted(() => ({
  closeTerminalTabMock: vi.fn(),
  activateAndRevealWorktreeMock: vi.fn()
}))

vi.mock('@/components/terminal/terminal-tab-actions', () => ({
  closeTerminalTab: closeTerminalTabMock
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activateAndRevealWorktreeMock,
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

type WorktreesChangedListener = (data: { repoId: string }) => void | Promise<void>
type ActivateWorktreeListener = (data: { repoId: string; worktreeId: string }) => void

function createWindowApi(listeners: {
  onWorktreesChanged: (listener: WorktreesChangedListener) => void
  onActivateWorktree: (listener: ActivateWorktreeListener) => void
}): Record<string, unknown> {
  return {
    api: {
      repos: { onChanged: () => () => {} },
      worktrees: {
        onChanged: (listener: WorktreesChangedListener) => {
          listeners.onWorktreesChanged(listener)
          return () => {}
        },
        onBaseStatus: () => () => {},
        onRemoteBranchConflict: () => () => {}
      },
      ui: {
        onStateChanged: () => () => {},
        onOpenSettings: () => () => {},
        onOpenFeatureTour: () => () => {},
        onToggleLeftSidebar: () => () => {},
        onToggleRightSidebar: () => () => {},
        onToggleWorktreePalette: () => () => {},
        onToggleFloatingTerminal: () => () => {},
        onOpenQuickOpen: () => () => {},
        onOpenNewWorkspace: () => () => {},
        onOpenTasks: () => () => {},
        onJumpToWorktreeIndex: () => () => {},
        onJumpToTabIndex: () => () => {},
        onWorktreeHistoryNavigate: () => () => {},
        onActivateWorktree: (listener: ActivateWorktreeListener) => {
          listeners.onActivateWorktree(listener)
          return () => {}
        },
        onCreateTerminal: () => () => {},
        onRequestTerminalCreate: () => () => {},
        replyTerminalCreate: () => {},
        onSplitTerminal: () => () => {},
        onRenameTerminal: () => () => {},
        onFocusTerminal: () => () => {},
        onFocusEditorTab: () => () => {},
        onCloseSessionTab: () => () => {},
        onMoveSessionTab: () => () => {},
        onOpenFileFromMobile: () => () => {},
        onOpenDiffFromMobile: () => () => {},
        onCloseTerminal: () => () => {},
        onSleepWorktree: () => () => {},
        onNewBrowserTab: () => () => {},
        onNewMarkdownTab: () => () => {},
        onRequestTabCreate: () => () => {},
        replyTabCreate: () => {},
        onRequestTabClose: () => () => {},
        replyTabClose: () => {},
        onRequestTabSetProfile: () => () => {},
        replyTabSetProfile: () => {},
        onNewTerminalTab: () => () => {},
        onCloseActiveTab: () => () => {},
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
      settings: { onChanged: () => () => {} },
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
      runtimeEnvironments: {
        subscribe: () => Promise.resolve({ unsubscribe: vi.fn(), sendBinary: vi.fn() })
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
        onBrowserDriverChanged: () => () => {}
      },
      agentStatus: { onSet: () => () => {} }
    }
  }
}

function createStoreState(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    fetchRepos: vi.fn(),
    fetchRuntimeEnvironmentRepos: vi.fn(),
    fetchProjectGroups: vi.fn(),
    fetchFolderWorkspaces: vi.fn(),
    fetchWorktrees: vi.fn(),
    fetchWorktreeLineage: vi.fn(),
    purgeWorktreeTerminalState: vi.fn(),
    removeWorkspaceSpaceWorktrees: vi.fn(),
    setUpdateStatus: vi.fn(),
    activeModal: null,
    closeModal: vi.fn(),
    openModal: vi.fn(),
    getKnownWorktreeById: vi.fn(),
    activeWorktreeId: 'repo-local::/old',
    activeView: 'terminal',
    setActiveView: vi.fn(),
    setActiveRepo: vi.fn(),
    setActiveWorktree: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
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
    updateWorktreeBaseStatus: vi.fn(),
    updateWorktreeRemoteBranchConflict: vi.fn(),
    repos: [],
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    detectedWorktreesByRepo: {},
    worktreesByRepo: {},
    settings: { activeRuntimeEnvironmentId: 'env-focused', terminalFontSize: 13 },
    ...overrides
  }
}

function requireListener<T>(listener: T | null): NonNullable<T> {
  if (!listener) {
    throw new Error('Expected IPC listener to be registered')
  }
  return listener as NonNullable<T>
}

function useMountedIpcEvents(useIpcEvents: () => void): void {
  useIpcEvents()
}

async function importUseIpcEventsWithMocks(storeState: Record<string, unknown>, listeners: {
  onWorktreesChanged: (listener: WorktreesChangedListener) => void
  onActivateWorktree: (listener: ActivateWorktreeListener) => void
}): Promise<() => void> {
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
  vi.doMock('@/lib/ui-zoom', () => ({ applyUIZoom: vi.fn() }))
  vi.doMock('@/components/sidebar/visible-worktrees', () => ({ getVisibleWorktreeIds: () => [] }))
  vi.doMock('@/lib/editor-font-zoom', () => ({
    nextEditorFontZoomLevel: vi.fn(() => 0),
    computeEditorFontSize: vi.fn(() => 13)
  }))
  vi.doMock('@/components/settings/SettingsConstants', () => ({
    zoomLevelToPercent: vi.fn(() => 100),
    ZOOM_MIN: -3,
    ZOOM_MAX: 3
  }))
  vi.doMock('@/lib/zoom-events', () => ({ dispatchZoomLevelChanged: vi.fn() }))
  vi.stubGlobal('window', createWindowApi(listeners))

  const { useIpcEvents } = await import('./useIpcEvents')
  return useIpcEvents
}

describe('useIpcEvents worktree owner routing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    activateAndRevealWorktreeMock.mockReset()
    closeTerminalTabMock.mockReset()
  })

  it('refreshes and activates local-owned agent worktrees while a runtime is focused', async () => {
    const listeners = {
      worktreesChanged: null as WorktreesChangedListener | null,
      activateWorktree: null as ActivateWorktreeListener | null
    }
    const fetchWorktrees = vi.fn().mockResolvedValue(true)
    const fetchWorktreeLineage = vi.fn().mockResolvedValue(undefined)
    const getKnownWorktreeById = vi.fn((id: string) =>
      id === 'repo-local::/new' ? { id, repoId: 'repo-local' } : undefined
    )
    const storeState = createStoreState({
      fetchWorktrees,
      fetchWorktreeLineage,
      getKnownWorktreeById,
      repos: [{ id: 'repo-local', connectionId: null, executionHostId: 'local' }]
    })

    const useIpcEvents = await importUseIpcEventsWithMocks(storeState, {
      onWorktreesChanged: (listener) => {
        listeners.worktreesChanged = listener
      },
      onActivateWorktree: (listener) => {
        listeners.activateWorktree = listener
      }
    })
    useMountedIpcEvents(useIpcEvents)
    await Promise.resolve()

    await requireListener(listeners.worktreesChanged)({ repoId: 'repo-local' })
    requireListener(listeners.activateWorktree)({
      repoId: 'repo-local',
      worktreeId: 'repo-local::/new'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchWorktrees).toHaveBeenCalledWith('repo-local')
    expect(fetchWorktreeLineage).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorktreeMock).toHaveBeenCalledWith('repo-local::/new', {
      notifyHostRuntime: false
    })
  })

  it('leaves focused-runtime worktree notifications to the runtime event stream', async () => {
    const listeners = {
      worktreesChanged: null as WorktreesChangedListener | null,
      activateWorktree: null as ActivateWorktreeListener | null
    }
    const fetchWorktrees = vi.fn().mockResolvedValue(true)
    const storeState = createStoreState({
      fetchWorktrees,
      repos: [{ id: 'repo-runtime', connectionId: null, executionHostId: 'runtime:env-focused' }]
    })

    const useIpcEvents = await importUseIpcEventsWithMocks(storeState, {
      onWorktreesChanged: (listener) => {
        listeners.worktreesChanged = listener
      },
      onActivateWorktree: (listener) => {
        listeners.activateWorktree = listener
      }
    })
    useMountedIpcEvents(useIpcEvents)
    await Promise.resolve()

    await requireListener(listeners.worktreesChanged)({ repoId: 'repo-runtime' })
    requireListener(listeners.activateWorktree)({
      repoId: 'repo-runtime',
      worktreeId: 'repo-runtime::/new'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(activateAndRevealWorktreeMock).not.toHaveBeenCalled()
  })
})
