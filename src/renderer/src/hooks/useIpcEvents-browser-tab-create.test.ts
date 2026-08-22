import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('useIpcEvents browser tab create routing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('leases the newly created browser page even when another page is active', async () => {
    const acquireBrowserAutomationVisibility = vi.fn(() => 'lease-new-page')
    const releaseBrowserAutomationVisibility = vi.fn()
    const replyTabCreate = vi.fn()
    const dispatchEvent = vi.fn()
    const requestTabCreateListenerRef: {
      current:
        | ((data: {
            requestId: string
            worktreeId?: string | null
            browserPageId?: string
            url: string
            sessionProfileId?: string
          }) => void)
        | null
    } = { current: null }
    const activateViewListenerRef: {
      current:
        | ((data: { worktreeId?: string | null; browserPageId?: string | null }) => void)
        | null
    } = { current: null }
    const state = {
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
      settings: { terminalFontSize: 13 },
      activeBrowserTabIdByWorktree: { 'wt-1': 'workspace-active' },
      browserTabsByWorktree: {
        'wt-1': [{ id: 'workspace-active', activePageId: 'page-active', pageIds: ['page-active'] }],
        'wt-2': [
          { id: 'workspace-detached', activePageId: 'page-detached', pageIds: ['page-detached'] }
        ]
      },
      browserPagesByWorkspace: {
        'workspace-active': [{ id: 'page-active', worktreeId: 'wt-1' }],
        'workspace-detached': [{ id: 'page-detached', worktreeId: 'wt-2' }]
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-active',
            groupId: 'group-1',
            contentType: 'browser',
            entityId: 'workspace-active'
          }
        ]
      },
      createBrowserTab: vi.fn(
        (
          _worktreeId: string,
          _url: string,
          options: { activate?: boolean; browserPageId?: string }
        ) => {
          const pageId = options.browserPageId ?? 'page-new'
          const workspace = { id: 'workspace-new', activePageId: pageId, pageIds: [pageId] }
          state.browserTabsByWorktree['wt-1'].push(workspace)
          state.browserPagesByWorkspace['workspace-new'] = [{ id: pageId, worktreeId: 'wt-1' }]
          expect(options.activate).toBe(false)
          return workspace
        }
      )
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
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => state
      }
    }))
    vi.doMock('@/components/browser-pane/host-guest/browser-automation-visibility', () => ({
      acquireBrowserAutomationVisibility,
      releaseBrowserAutomationVisibility
    }))
    vi.doMock('@/lib/ui-zoom', () => ({ applyUIZoom: vi.fn() }))
    vi.doMock('@/lib/worktree-activation', () => ({
      activateAndRevealWorktree: vi.fn(),
      ensureWorktreeHasInitialTerminal: vi.fn()
    }))
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

    vi.stubGlobal('window', {
      dispatchEvent,
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      api: {
        repos: { onChanged: () => () => {} },
        worktrees: {
          onChanged: () => () => {},
          onGitStatusMetadataChanged: () => () => {},
          onHeadIdentitiesChanged: () => () => {},
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
          onRequestTabCreate: (
            listener: NonNullable<typeof requestTabCreateListenerRef.current>
          ) => {
            requestTabCreateListenerRef.current = listener
            return () => {}
          },
          replyTabCreate,
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
          onActivateView: (listener: NonNullable<typeof activateViewListenerRef.current>) => {
            activateViewListenerRef.current = listener
            return () => {}
          },
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
          onBrowserDriverChanged: () => () => {}
        },
        agentStatus: { onSet: () => () => {} }
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    requestTabCreateListenerRef.current?.({
      requestId: 'req-create',
      worktreeId: 'wt-1',
      browserPageId: 'page-canonical',
      url: 'https://example.com'
    })

    expect(acquireBrowserAutomationVisibility).toHaveBeenCalledWith('page-canonical')
    expect(acquireBrowserAutomationVisibility).not.toHaveBeenCalledWith('page-active')
    expect(state.createBrowserTab).toHaveBeenCalledWith(
      'wt-1',
      'https://example.com',
      expect.objectContaining({ activate: false, browserPageId: 'page-canonical' })
    )
    expect(state.createBrowserTab.mock.calls[0]?.[2]).not.toHaveProperty('allowWindowClose')
    expect(replyTabCreate).toHaveBeenCalledWith({
      requestId: 'req-create',
      browserPageId: 'page-canonical'
    })
    expect(dispatchEvent).toHaveBeenCalled()
    expect(releaseBrowserAutomationVisibility).not.toHaveBeenCalled()

    acquireBrowserAutomationVisibility.mockClear()
    dispatchEvent.mockClear()

    activateViewListenerRef.current?.({ browserPageId: 'page-detached' })

    expect(acquireBrowserAutomationVisibility).toHaveBeenCalledWith('page-detached')
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { worktreeId: 'wt-2' } })
    )
  })

  it('creates a local tab while a remote runtime is focused if the worktree is local', async () => {
    const replyTabCreate = vi.fn()
    const requestTabCreateListenerRef: {
      current:
        | ((data: { requestId: string; worktreeId?: string | null; url: string }) => void)
        | null
    } = { current: null }
    const createBrowserTab = vi.fn(() => ({
      id: 'workspace-new',
      activePageId: 'page-new',
      pageIds: ['page-new']
    }))
    const createWebRuntimeSessionBrowserTab = vi.fn()
    const state = {
      setUpdateStatus: vi.fn(),
      fetchRepos: vi.fn(),
      fetchWorktrees: vi.fn(),
      setActiveView: vi.fn(),
      activeModal: null,
      closeModal: vi.fn(),
      openModal: vi.fn(),
      activeWorktreeId: 'wt-local',
      activeView: 'terminal',
      setActiveRepo: vi.fn(),
      setActiveWorktree: vi.fn(),
      revealWorktreeInSidebar: vi.fn(),
      setIsFullScreen: vi.fn(),
      updateBrowserTabPageState: vi.fn(),
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
      settings: { terminalFontSize: 13, activeRuntimeEnvironmentId: 'env-focused' },
      activeBrowserTabIdByWorktree: {},
      browserTabsByWorktree: { 'wt-local': [] },
      browserPagesByWorkspace: { 'workspace-new': [{ id: 'page-new', worktreeId: 'wt-local' }] },
      unifiedTabsByWorktree: {},
      createBrowserTab
    }

    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return { ...actual, useEffect: (effect: () => void | (() => void)) => effect() }
    })
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => state }
    }))
    vi.doMock('@/lib/worktree-runtime-owner', () => ({
      getRuntimeEnvironmentIdForWorktree: () => null,
      getExplicitRuntimeEnvironmentIdForWorktree: () => null
    }))
    vi.doMock('@/runtime/web-runtime-session', () => ({
      closeWebRuntimeSessionTab: vi.fn(),
      createWebRuntimeSessionBrowserTab,
      createWebRuntimeSessionTerminal: vi.fn(),
      isWebRuntimeSessionActive: () => false
    }))
    vi.doMock('@/components/browser-pane/browser-automation-visibility', () => ({
      acquireBrowserAutomationVisibility: vi.fn(),
      releaseBrowserAutomationVisibility: vi.fn()
    }))
    vi.doMock('@/lib/ui-zoom', () => ({ applyUIZoom: vi.fn() }))
    vi.doMock('@/lib/worktree-activation', () => ({
      activateAndRevealWorktree: vi.fn(),
      ensureWorktreeHasInitialTerminal: vi.fn()
    }))
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
    stubUiWindow({
      requestTabCreateListenerRef,
      replyTabCreate
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    requestTabCreateListenerRef.current?.({
      requestId: 'req-local',
      worktreeId: 'wt-local',
      url: 'https://example.com'
    })

    expect(createBrowserTab).toHaveBeenCalledWith(
      'wt-local',
      'https://example.com',
      expect.objectContaining({ activate: false })
    )
    expect(createWebRuntimeSessionBrowserTab).not.toHaveBeenCalled()
    expect(replyTabCreate).toHaveBeenCalledWith({
      requestId: 'req-local',
      browserPageId: 'page-new'
    })
    expect(replyTabCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringMatching(/unavailable while a remote runtime is active/)
      })
    )
  })

  it('creates a remote-owned worktree tab on the owning environment', async () => {
    const replyTabCreate = vi.fn()
    const requestTabCreateListenerRef: {
      current:
        | ((data: { requestId: string; worktreeId?: string | null; url: string }) => void)
        | null
    } = { current: null }
    const createBrowserTab = vi.fn()
    const createWebRuntimeSessionBrowserTab = vi.fn(
      async (args: { onCreatedPage?: (browserPageId: string) => void }) => {
        args.onCreatedPage?.('remote-page-1')
        return true
      }
    )
    const state = {
      setUpdateStatus: vi.fn(),
      fetchRepos: vi.fn(),
      fetchWorktrees: vi.fn(),
      setActiveView: vi.fn(),
      activeModal: null,
      closeModal: vi.fn(),
      openModal: vi.fn(),
      activeWorktreeId: 'wt-remote',
      activeView: 'terminal',
      setActiveRepo: vi.fn(),
      setActiveWorktree: vi.fn(),
      revealWorktreeInSidebar: vi.fn(),
      setIsFullScreen: vi.fn(),
      updateBrowserTabPageState: vi.fn(),
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
      settings: { terminalFontSize: 13, activeRuntimeEnvironmentId: 'env-other' },
      activeBrowserTabIdByWorktree: {},
      browserTabsByWorktree: { 'wt-remote': [] },
      browserPagesByWorkspace: {},
      unifiedTabsByWorktree: {},
      createBrowserTab
    }

    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return { ...actual, useEffect: (effect: () => void | (() => void)) => effect() }
    })
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => state }
    }))
    vi.doMock('@/lib/worktree-runtime-owner', () => ({
      getRuntimeEnvironmentIdForWorktree: () => 'env-owner',
      getExplicitRuntimeEnvironmentIdForWorktree: () => 'env-owner'
    }))
    vi.doMock('@/runtime/web-runtime-session', () => ({
      closeWebRuntimeSessionTab: vi.fn(),
      createWebRuntimeSessionBrowserTab,
      createWebRuntimeSessionTerminal: vi.fn(),
      isWebRuntimeSessionActive: () => false
    }))
    vi.doMock('@/components/browser-pane/browser-automation-visibility', () => ({
      acquireBrowserAutomationVisibility: vi.fn(),
      releaseBrowserAutomationVisibility: vi.fn()
    }))
    vi.doMock('@/lib/ui-zoom', () => ({ applyUIZoom: vi.fn() }))
    vi.doMock('@/lib/worktree-activation', () => ({
      activateAndRevealWorktree: vi.fn(),
      ensureWorktreeHasInitialTerminal: vi.fn()
    }))
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
    stubUiWindow({
      requestTabCreateListenerRef,
      replyTabCreate
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    requestTabCreateListenerRef.current?.({
      requestId: 'req-remote',
      worktreeId: 'wt-remote',
      url: 'https://example.com'
    })
    await vi.waitFor(() =>
      expect(replyTabCreate).toHaveBeenCalledWith({
        requestId: 'req-remote',
        browserPageId: 'remote-page-1',
        hostedRemotely: true
      })
    )
    expect(createWebRuntimeSessionBrowserTab).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-remote',
        environmentId: 'env-owner',
        url: 'https://example.com',
        selectWorktree: false
      })
    )
    expect(createBrowserTab).not.toHaveBeenCalled()
  })
})

function stubUiWindow(args: {
  requestTabCreateListenerRef: { current: ((data: never) => void) | null }
  replyTabCreate: ReturnType<typeof vi.fn>
}): void {
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
    api: {
      repos: { onChanged: () => () => {} },
      worktrees: {
        onChanged: () => () => {},
        onGitStatusMetadataChanged: () => () => {},
        onHeadIdentitiesChanged: () => () => {},
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
        onCloseSessionTab: () => () => {},
        onMoveSessionTab: () => () => {},
        onOpenFileFromMobile: () => () => {},
        onOpenDiffFromMobile: () => () => {},
        onCloseTerminal: () => () => {},
        onSleepWorktree: () => () => {},
        onResumeSleepingAgents: () => () => {},
        onNewBrowserTab: () => () => {},
        onNewMarkdownTab: () => () => {},
        onRequestTabCreate: (listener: (data: never) => void) => {
          args.requestTabCreateListenerRef.current = listener
          return () => {}
        },
        replyTabCreate: args.replyTabCreate,
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
  })
}
