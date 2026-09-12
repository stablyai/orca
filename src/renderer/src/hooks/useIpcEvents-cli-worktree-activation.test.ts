import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'

describe('useIpcEvents CLI-created worktree activation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  // Why: regression guard. The CLI "create agent" flow emits
  // `ui:activateWorktree` to switch the user to the new workspace. A prior
  // implementation hand-rolled the activation (setActiveRepo + setActiveView
  // + setActiveWorktree + ensureWorktreeHasInitialTerminal +
  // revealWorktreeInSidebar), which bypassed recordWorktreeVisit and left
  // the back/forward buttons ignoring the CLI-driven switch. This test pins
  // the handler to the canonical `activateAndRevealWorktree` helper, which
  // is the single place that records the visit in history.
  it('routes ui:activateWorktree intents through their workspace activation paths', async () => {
    const callOrder: string[] = []
    const activateAndRevealWorktree = vi.fn(() => {
      callOrder.push('activate project')
      return { primaryTabId: 'tab-native' }
    })
    const activateAndRevealWorkspace = vi.fn((): { primaryTabId: string } | false => {
      callOrder.push('activate workspace')
      return { primaryTabId: 'tab-folder' }
    })
    const activateTabAndFocusPane = vi.fn(() => {
      callOrder.push('focus pane')
    })
    const activateNotificationRuntimeTarget = vi.fn().mockResolvedValue(true)
    const settings = { activeRuntimeEnvironmentId: null as string | null, terminalFontSize: 13 }
    const nativeChatTab = { id: 'tab-native', ptyId: 'pty-native', viewMode: 'chat' }
    let tabsByWorktree: Record<string, (typeof nativeChatTab)[]> = {
      'wt-existing': [nativeChatTab]
    }
    let terminalLayoutsByTabId: Record<string, unknown> = {}
    let worktreeKnown = false
    const fetchWorktrees = vi.fn().mockImplementation(async () => {
      callOrder.push('fetch')
      worktreeKnown = true
    })
    const activateWorktreeListenerRef: {
      current:
        | ((data: {
            repoId?: string
            worktreeId: string
            setup?: { runnerScriptPath: string; envVars: Record<string, string> }
            notificationPaneKey?: string | null
            executionHostId?: 'local' | `ssh:${string}` | `runtime:${string}`
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
          clearPortForwards: vi.fn(),
          setDetectedPorts: vi.fn(),
          enqueueSshCredentialRequest: vi.fn(),
          removeSshCredentialRequest: vi.fn(),
          clearTabPtyId: vi.fn(),
          tabsByWorktree,
          terminalLayoutsByTabId,
          suppressedPtyExitIds: {},
          settings
        })
      }
    }))

    vi.doMock('@/lib/ui-zoom', () => ({
      applyUIZoom: vi.fn()
    }))
    vi.doMock('@/lib/worktree-activation', () => ({
      activateAndRevealWorktree,
      activateAndRevealWorkspace,
      ensureWorktreeHasInitialTerminal: vi.fn()
    }))
    vi.doMock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane }))
    vi.doMock('./ipc-events/notification-runtime-navigation', () => ({
      activateNotificationRuntimeTarget
    }))
    vi.doMock('@/runtime/web-runtime-session', () => ({
      closeWebRuntimeSessionTab: vi.fn(),
      createWebRuntimeSessionTerminal: vi.fn(),
      isWebRuntimeSessionActive: (environmentId: string | null | undefined) =>
        Boolean(environmentId?.trim())
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
              repoId?: string
              worktreeId: string
              setup?: { runnerScriptPath: string; envVars: Record<string, string> }
              notificationPaneKey?: string | null
              executionHostId?: 'local' | `ssh:${string}` | `runtime:${string}`
            }) => void
          ) => {
            activateWorktreeListenerRef.current = listener
            return () => {}
          },
          onCreateTerminal: () => () => {},
          onRequestTerminalCreate: () => () => {},
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
          onSleepWorktree: () => () => {},
          onResumeSleepingAgents: () => () => {},
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
          onCloseFloatingItem: () => () => {},
          onSelectFloatingIndex: () => () => {},
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

    // Wait for the async IPC handler (it awaits fetchWorktrees before activating).
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Worktrees must be fetched first so activateAndRevealWorktree can resolve
    // the CLI-created worktree out of store state.
    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1')

    // The core regression guard: the handler must delegate to the canonical
    // activation helper (which records the visit in history) rather than
    // hand-rolling the activation steps and skipping recordWorktreeVisit.
    // `setup` must be passed through the `setup` opt — not positionally
    // mis-aliased into `startup`, which was a latent bug in the original
    // hand-rolled path.
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

    // Why: a folder workspace has no repo to fetch — it activates by workspace id alone.
    activateAndRevealWorktree.mockClear()
    fetchWorktrees.mockClear()
    activateWorktreeListenerRef.current({ worktreeId: 'folder:folder-1' })

    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('folder:folder-1', {})

    // Why: the ordering this feature exists for — pane focus lands only after activation resolves.
    activateAndRevealWorktree.mockClear()
    fetchWorktrees.mockClear()
    callOrder.length = 0
    const paneKey = 'tab-native:123e4567-e89b-42d3-a456-426614174000'
    activateWorktreeListenerRef.current({
      repoId: 'repo-1',
      worktreeId: 'wt-existing',
      notificationPaneKey: paneKey,
      executionHostId: 'local'
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(callOrder).toEqual(['fetch', 'activate project', 'focus pane'])
    expect(activateAndRevealWorktree).toHaveBeenLastCalledWith('wt-existing', {
      executionHostId: 'local',
      notifyHostRuntime: false,
      providesInitialSurface: true
    })
    expect(activateTabAndFocusPane).toHaveBeenCalledWith(
      'tab-native',
      '123e4567-e89b-42d3-a456-426614174000',
      {
        ackPaneKeyOnSuccess: paneKey,
        flashFocusedPane: true,
        scrollToBottomIfOutputSinceLastView: true
      }
    )

    // Why: a null pane key is the project-only fallback — activate, never focus.
    activateAndRevealWorktree.mockClear()
    activateTabAndFocusPane.mockClear()
    activateWorktreeListenerRef.current({
      repoId: 'repo-1',
      worktreeId: 'wt-existing',
      notificationPaneKey: null,
      executionHostId: 'local'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(activateAndRevealWorktree).toHaveBeenLastCalledWith('wt-existing', {
      executionHostId: 'local',
      notifyHostRuntime: false,
      providesInitialSurface: true
    })
    expect(activateTabAndFocusPane).not.toHaveBeenCalled()

    // Why: a closed session keeps its project open — it is never recreated.
    activateAndRevealWorktree.mockClear()
    tabsByWorktree = { 'wt-existing': [] }
    terminalLayoutsByTabId = {}
    activateWorktreeListenerRef.current({
      repoId: 'repo-1',
      worktreeId: 'wt-existing',
      notificationPaneKey: paneKey,
      executionHostId: 'local'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(activateTabAndFocusPane).not.toHaveBeenCalled()

    // Why: the tab survived but the notifying leaf did not.
    activateAndRevealWorktree.mockClear()
    tabsByWorktree = { 'wt-existing': [nativeChatTab] }
    terminalLayoutsByTabId = {
      'tab-native': {
        root: { type: 'leaf', leafId: '123e4567-e89b-42d3-a456-426614174001' }
      }
    }
    activateWorktreeListenerRef.current({
      repoId: 'repo-1',
      worktreeId: 'wt-existing',
      notificationPaneKey: paneKey,
      executionHostId: 'local'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(activateTabAndFocusPane).not.toHaveBeenCalled()

    // Why: the pane must belong to the notifying workspace, not merely exist somewhere.
    activateAndRevealWorktree.mockClear()
    tabsByWorktree = { 'wt-other': [nativeChatTab] }
    terminalLayoutsByTabId = {}
    activateWorktreeListenerRef.current({
      repoId: 'repo-1',
      worktreeId: 'wt-existing',
      notificationPaneKey: paneKey,
      executionHostId: 'local'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(activateTabAndFocusPane).not.toHaveBeenCalled()

    // Why: folder workspaces get the same ordered focus, without a fetch.
    activateAndRevealWorkspace.mockClear()
    activateTabAndFocusPane.mockClear()
    fetchWorktrees.mockClear()
    callOrder.length = 0
    tabsByWorktree = { 'folder:folder-1': [nativeChatTab] }
    activateWorktreeListenerRef.current({
      worktreeId: 'folder:folder-1',
      notificationPaneKey: paneKey,
      executionHostId: 'local'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(callOrder).toEqual(['activate workspace', 'focus pane'])
    expect(activateAndRevealWorkspace).toHaveBeenLastCalledWith('folder:folder-1', {
      executionHostId: 'local',
      providesInitialSurface: true
    })
    expect(activateTabAndFocusPane).toHaveBeenCalledWith(
      'tab-native',
      '123e4567-e89b-42d3-a456-426614174000',
      expect.anything()
    )

    // Why: a refused activation (missing/unmounted path) must not focus anything.
    activateAndRevealWorkspace.mockReturnValueOnce(false)
    activateTabAndFocusPane.mockClear()
    activateWorktreeListenerRef.current({
      worktreeId: 'folder:folder-1',
      notificationPaneKey: paneKey,
      executionHostId: 'local'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activateTabAndFocusPane).not.toHaveBeenCalled()

    // Why: fail closed — a notification intent without a resolvable owner is dropped.
    activateAndRevealWorktree.mockClear()
    fetchWorktrees.mockClear()
    activateWorktreeListenerRef.current({
      repoId: 'repo-1',
      worktreeId: 'wt-existing',
      notificationPaneKey: null
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()

    activateWorktreeListenerRef.current({
      repoId: 'repo-1',
      worktreeId: 'wt-existing',
      notificationPaneKey: null,
      executionHostId: 'bogus' as 'local'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()

    // Why: an ordinary CLI intent stays blocked while a runtime environment owns the window.
    settings.activeRuntimeEnvironmentId = 'env-1'
    activateAndRevealWorktree.mockClear()
    activateWorktreeListenerRef.current({ repoId: 'repo-1', worktreeId: 'wt-existing' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()

    activateWorktreeListenerRef.current({
      repoId: 'repo-1',
      worktreeId: 'wt-existing',
      notificationPaneKey: null
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()

    // Why: a host-qualified notification may cross that gate, and scopes its own fetch.
    activateAndRevealWorktree.mockClear()
    fetchWorktrees.mockClear()
    activateWorktreeListenerRef.current({
      repoId: 'repo-1',
      worktreeId: 'wt-existing',
      notificationPaneKey: null,
      executionHostId: 'local'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1', { executionHostId: 'local' })
    expect(activateAndRevealWorktree).toHaveBeenLastCalledWith('wt-existing', {
      executionHostId: 'local',
      notifyHostRuntime: false,
      providesInitialSurface: true
    })

    activateAndRevealWorktree.mockClear()
    fetchWorktrees.mockClear()
    activateWorktreeListenerRef.current({
      repoId: 'repo-1',
      worktreeId: 'wt-existing',
      notificationPaneKey: null,
      executionHostId: 'ssh:notification-origin'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      executionHostId: 'ssh:notification-origin'
    })
    expect(activateAndRevealWorktree).toHaveBeenLastCalledWith('wt-existing', {
      executionHostId: 'ssh:notification-origin',
      notifyHostRuntime: false,
      providesInitialSurface: true
    })

    activateAndRevealWorkspace.mockClear()
    activateWorktreeListenerRef.current({
      worktreeId: 'folder:folder-1',
      notificationPaneKey: null,
      executionHostId: 'ssh:folder-origin'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activateAndRevealWorkspace).toHaveBeenLastCalledWith('folder:folder-1', {
      executionHostId: 'ssh:folder-origin',
      providesInitialSurface: true
    })

    // Why: a runtime pane is selected on the host before the client focuses it.
    tabsByWorktree = { 'wt-existing': [nativeChatTab] }
    const runtimeIntent = {
      repoId: 'repo-1',
      worktreeId: 'wt-existing',
      notificationPaneKey: paneKey,
      executionHostId: 'runtime:env-1' as const
    }
    nativeChatTab.ptyId = toRemoteRuntimePtyId('pty-native', 'env-1')
    vi.clearAllMocks()
    activateWorktreeListenerRef.current(runtimeIntent)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activateNotificationRuntimeTarget).toHaveBeenCalledWith({
      executionHostId: 'runtime:env-1',
      worktreeId: 'wt-existing',
      tabId: 'tab-native',
      leafId: '123e4567-e89b-42d3-a456-426614174000'
    })

    vi.clearAllMocks()
    activateNotificationRuntimeTarget.mockResolvedValueOnce(false)
    activateWorktreeListenerRef.current(runtimeIntent)
    await vi.waitFor(() => expect(activateNotificationRuntimeTarget).toHaveBeenCalledTimes(1))
    expect(activateTabAndFocusPane).not.toHaveBeenCalled()

    // Why: latest click wins — a slower earlier intent must not steal focus when it lands.
    const oldFetch = Promise.withResolvers<void>()
    const newFetch = Promise.withResolvers<void>()
    nativeChatTab.ptyId = 'pty-native'
    tabsByWorktree = { 'wt-new-intent': [nativeChatTab] }
    fetchWorktrees.mockImplementation((repoId: string) =>
      repoId === 'repo-old' ? oldFetch.promise : newFetch.promise
    )
    activateAndRevealWorktree.mockClear()
    activateTabAndFocusPane.mockClear()
    activateWorktreeListenerRef.current({
      repoId: 'repo-old',
      worktreeId: 'wt-old-intent',
      notificationPaneKey: paneKey,
      executionHostId: 'local'
    })
    activateWorktreeListenerRef.current({
      repoId: 'repo-new',
      worktreeId: 'wt-new-intent',
      notificationPaneKey: paneKey,
      executionHostId: 'local'
    })
    newFetch.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    oldFetch.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-new-intent', {
      executionHostId: 'local',
      notifyHostRuntime: false,
      providesInitialSurface: true
    })
    expect(activateTabAndFocusPane).toHaveBeenCalledTimes(1)
    expect(activateTabAndFocusPane).toHaveBeenCalledWith(
      'tab-native',
      '123e4567-e89b-42d3-a456-426614174000',
      expect.anything()
    )
  })

  it('routes local and runtime worktree events to their owning hosts', async () => {
    const fetchWorktrees = vi.fn()
    const fetchWorktreeLineage = vi.fn()
    // Mutable so the test can drop the runtime mid-run and prove the local flag
    // is origin-based, not a sample of runtime state.
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
          onSleepWorktree: () => () => {},
          onResumeSleepingAgents: () => () => {},
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
          onCloseFloatingItem: () => () => {},
          onSelectFloatingIndex: () => () => {},
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
    // With no runtime active the flag must still be true — it marks the event's
    // local origin; sampling runtime state here would regress to false.
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
