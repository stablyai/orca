import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('useIpcEvents CLI-created worktree activation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  // Canonical activateAndRevealWorktree records CLI-driven navigation in back/forward history; hand-rolled activation bypassed visits.
  it('uses immediate reveal only for newly fetched ui:activateWorktree targets', async () => {
    const activateAndRevealWorktree = vi.fn()
    let worktreeKnown = false
    const fetchWorktrees = vi.fn().mockImplementation(async () => {
      worktreeKnown = true
    })
    const activateWorktreeListenerRef: {
      current:
        | ((data: {
            repoId: string
            worktreeId: string
            setup?: { runnerScriptPath: string; envVars: Record<string, string> }
          }) => void)
        | null
    } = { current: null }

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
        getState: () => ({
          fetchRepos: vi.fn(),
          fetchWorktrees,
          setUpdateStatus: vi.fn(),
          activeModal: null,
          closeModal: vi.fn(),
          openModal: vi.fn(),
          getKnownWorktreeById: vi.fn((id: string) => {
            if (id === 'wt-existing') {
              return { id, repoId: 'repo-1' }
            }
            return worktreeKnown && id === 'wt-new' ? { id, repoId: 'repo-1' } : undefined
          }),
          activeWorktreeId: 'wt-old',
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
          setUnrestoredPortForwards: vi.fn(),
          clearPortForwards: vi.fn(),
          setDetectedPorts: vi.fn(),
          enqueueSshCredentialRequest: vi.fn(),
          removeSshCredentialRequest: vi.fn(),
          clearTabPtyId: vi.fn(),
          settings: { terminalFontSize: 13 }
        })
      }
    }))

    vi.doMock('@/lib/ui-zoom', () => ({
      applyUIZoom: vi.fn()
    }))
    vi.doMock('@/lib/worktree-activation', () => ({
      activateAndRevealWorktree,
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

    vi.stubGlobal('window', {
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
          onActivateWorktree: (
            listener: (data: {
              repoId: string
              worktreeId: string
              setup?: { runnerScriptPath: string; envVars: Record<string, string> }
            }) => void
          ) => {
            activateWorktreeListenerRef.current = listener
            return () => {}
          },
          onCreateTerminal: () => () => {},
          onRequestTerminalCreate: () => () => {},
          onPublishAgentLaunchTab: () => () => {},
          onRevealTerminalPane: () => () => {},
          onAgentLaunchPaneVerdict: () => () => {},
          onLaunchRecipe: () => () => {},
          onRequestTerminalTabMount: () => () => {},
          replyTerminalCreate: () => {},
          onSplitTerminal: () => () => {},
          onRenameTerminal: () => () => {},
          onFocusTerminal: () => () => {},
          onFocusEditorTab: () => () => {},
          onCloseSessionTab: () => () => {},
          onSessionTabCloseRequest: () => () => {},
          respondSessionTabClose: () => {},
          onMoveSessionTab: () => () => {},
          onOpenFileFromMobile: () => () => {},
          onOpenDiffFromMobile: () => () => {},
          onCloseTerminal: () => () => {},
          onWorkspaceSleep: () => () => {},
          onResumeSleepingAgents: () => () => {},
          onRequestTabCreate: () => () => {},
          onRequestRemoteCliBrowserScope: () => () => {},
          replyTabCreate: () => {},
          onRequestTabClose: () => () => {},
          replyTabClose: () => {},
          onRequestTabSetProfile: () => () => {},
          replyTabSetProfile: () => {},
          onCloseActiveTab: () => () => {},
          onCloseFloatingItem: () => () => {},
          onSelectFloatingIndex: () => () => {},
          onBrowserPageTabShortcut: () => () => {},
          onSwitchRecentTab: () => () => {},
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
          onSessionProfilesChanged: () => () => {},
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
          listUnrestoredPortForwards: () => Promise.resolve([]),
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
          onBrowserDriverChanged: () => () => {},
          onClientHostedBrowserRowsChanged: () => () => {},
          getClientHostedBrowserRows: async () => []
        },
        agentStatus: { onSet: () => () => {} }
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    if (typeof activateWorktreeListenerRef.current !== 'function') {
      throw new Error('Expected onActivateWorktree listener to be registered')
    }

    const setup = { runnerScriptPath: '/tmp/setup.sh', envVars: { FOO: 'bar' } }
    activateWorktreeListenerRef.current({
      repoId: 'repo-1',
      worktreeId: 'wt-new',
      setup
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Fetch before activation so renderer state can resolve the just-created CLI workspace.
    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1')

    // Delegate to canonical activation with setup in its own option; positional startup aliasing would regress launch semantics.
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-new', {
      setup,
      sidebarRevealBehavior: 'auto',
      notifyHostRuntime: false
    })

    activateAndRevealWorktree.mockClear()
    fetchWorktrees.mockClear()
    activateWorktreeListenerRef.current({
      repoId: 'repo-1',
      worktreeId: 'wt-existing'
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1')
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-existing', {
      notifyHostRuntime: false
    })
  })

  it('routes local and runtime worktree events to their owning hosts', async () => {
    const fetchWorktrees = vi.fn()
    const fetchWorktreeLineage = vi.fn()
    // Change runtime during the test to prove the local flag represents event origin, not focus state.
    const mockSettings: { activeRuntimeEnvironmentId: string | null; terminalFontSize: number } = {
      activeRuntimeEnvironmentId: 'env-1',
      terminalFontSize: 13
    }
    let localWorktreesOnChanged: ((data: { repoId: string }) => void) | undefined
    let runtimeOnResponse: ((response: unknown) => void) | undefined
    const runtimeSubscribe = vi.fn(async (_args, callbacks) => {
      runtimeOnResponse = (callbacks as { onResponse: (response: unknown) => void }).onResponse
      return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    })

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
        getState: () => ({
          fetchRepos: vi.fn(),
          fetchRuntimeEnvironmentRepos: vi.fn(),
          fetchProjectGroups: vi.fn(),
          fetchHostWorkspaceStatuses: vi.fn(),
          fetchWorktrees,
          fetchWorktreeLineage,
          repos: [{ id: 'repo-1' }],
          detectedWorktreesByRepo: {
            'repo-1': {
              repoId: 'repo-1',
              authoritative: true,
              source: 'git',
              worktrees: [{ id: 'wt-old' }]
            }
          },
          worktreesByRepo: {},
          purgeWorktreeTerminalState: vi.fn(),
          removeWorkspaceSpaceWorktrees: vi.fn(),
          setUpdateStatus: vi.fn(),
          activeModal: null,
          closeModal: vi.fn(),
          openModal: vi.fn(),
          getKnownWorktreeById: vi.fn(),
          activeWorktreeId: 'wt-old',
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
          setUnrestoredPortForwards: vi.fn(),
          clearPortForwards: vi.fn(),
          setDetectedPorts: vi.fn(),
          enqueueSshCredentialRequest: vi.fn(),
          removeSshCredentialRequest: vi.fn(),
          clearTabPtyId: vi.fn(),
          settings: mockSettings
        })
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

    vi.stubGlobal('window', {
      api: {
        repos: { onChanged: () => () => {} },
        automations: { onChanged: () => () => {} },
        worktrees: {
          onChanged: (callback: (data: { repoId: string }) => void) => {
            localWorktreesOnChanged = callback
            return () => {}
          },
          onBaseStatus: () => () => {},
          onRemoteBranchConflict: () => () => {}
        },
        runtimeEnvironments: { subscribe: runtimeSubscribe },
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
          onPublishAgentLaunchTab: () => () => {},
          onRevealTerminalPane: () => () => {},
          onAgentLaunchPaneVerdict: () => () => {},
          onLaunchRecipe: () => () => {},
          onRequestTerminalTabMount: () => () => {},
          replyTerminalCreate: () => {},
          onSplitTerminal: () => () => {},
          onRenameTerminal: () => () => {},
          onFocusTerminal: () => () => {},
          onFocusEditorTab: () => () => {},
          onCloseSessionTab: () => () => {},
          onSessionTabCloseRequest: () => () => {},
          respondSessionTabClose: () => {},
          onMoveSessionTab: () => () => {},
          onOpenFileFromMobile: () => () => {},
          onOpenDiffFromMobile: () => () => {},
          onCloseTerminal: () => () => {},
          onWorkspaceSleep: () => () => {},
          onResumeSleepingAgents: () => () => {},
          onRequestTabCreate: () => () => {},
          onRequestRemoteCliBrowserScope: () => () => {},
          replyTabCreate: () => {},
          onRequestTabClose: () => () => {},
          replyTabClose: () => {},
          onRequestTabSetProfile: () => () => {},
          replyTabSetProfile: () => {},
          onCloseActiveTab: () => () => {},
          onCloseFloatingItem: () => () => {},
          onSelectFloatingIndex: () => () => {},
          onBrowserPageTabShortcut: () => () => {},
          onSwitchRecentTab: () => () => {},
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
          onSessionProfilesChanged: () => () => {},
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
          listUnrestoredPortForwards: () => Promise.resolve([]),
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
          onBrowserDriverChanged: () => () => {},
          onClientHostedBrowserRowsChanged: () => () => {},
          getClientHostedBrowserRows: async () => []
        },
        agentStatus: { onSet: () => () => {} }
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    expect(runtimeSubscribe).toHaveBeenCalledWith(
      {
        selector: 'env-1',
        method: 'runtime.clientEvents.subscribe',
        timeoutMs: 15_000
      },
      expect.any(Object)
    )
    if (!localWorktreesOnChanged) {
      throw new Error('Expected local worktree event callback')
    }
    localWorktreesOnChanged({ repoId: 'repo-1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1', { forceLocalOwner: true })
    expect(fetchWorktreeLineage).toHaveBeenCalledWith({ forceLocalOwner: true })

    fetchWorktrees.mockClear()
    fetchWorktreeLineage.mockClear()
    // Local origin remains true even when no runtime is active.
    mockSettings.activeRuntimeEnvironmentId = null
    localWorktreesOnChanged({ repoId: 'repo-1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1', { forceLocalOwner: true })
    expect(fetchWorktreeLineage).toHaveBeenCalledWith({ forceLocalOwner: true })

    fetchWorktrees.mockClear()
    fetchWorktreeLineage.mockClear()
    mockSettings.activeRuntimeEnvironmentId = null
    if (!runtimeOnResponse) {
      throw new Error('Expected runtime client event callbacks')
    }
    runtimeOnResponse({
      ok: true,
      result: { type: 'worktreesChanged', repoId: 'repo-1' }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      executionHostId: 'runtime:env-1',
      suppressRemoteLineageRefresh: true
    })
    expect(fetchWorktreeLineage).toHaveBeenCalledWith({
      executionHostId: 'runtime:env-1'
    })
  })
})
