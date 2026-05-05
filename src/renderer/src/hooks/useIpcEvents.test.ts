/* eslint-disable max-lines -- Why: this test file keeps the hook wiring mocks close to the assertions so IPC event behavior stays understandable and maintainable. */
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveZoomTarget } from './useIpcEvents'

function makeTarget(args: { hasXtermClass?: boolean; editorClosest?: boolean }): {
  classList: { contains: (token: string) => boolean }
  closest: (selector: string) => Element | null
} {
  const { hasXtermClass = false, editorClosest = false } = args
  return {
    classList: {
      contains: (token: string) => hasXtermClass && token === 'xterm-helper-textarea'
    },
    closest: () => (editorClosest ? ({} as Element) : null)
  }
}

describe('resolveZoomTarget', () => {
  it('routes to terminal zoom when terminal tab is active', () => {
    expect(
      resolveZoomTarget({
        activeView: 'terminal',
        activeTabType: 'terminal',
        activeElement: makeTarget({ hasXtermClass: true })
      })
    ).toBe('terminal')
  })

  it('routes to editor zoom for editor tabs', () => {
    expect(
      resolveZoomTarget({
        activeView: 'terminal',
        activeTabType: 'editor',
        activeElement: makeTarget({})
      })
    ).toBe('editor')
  })

  it('routes to editor zoom when editor surface has focus during stale tab state', () => {
    expect(
      resolveZoomTarget({
        activeView: 'terminal',
        activeTabType: 'terminal',
        activeElement: makeTarget({ editorClosest: true })
      })
    ).toBe('editor')
  })

  it('routes to ui zoom outside terminal view', () => {
    expect(
      resolveZoomTarget({
        activeView: 'settings',
        activeTabType: 'terminal',
        activeElement: makeTarget({ hasXtermClass: true })
      })
    ).toBe('ui')
  })
})

describe('useIpcEvents updater integration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('routes updater status events into store state', async () => {
    const setUpdateStatus = vi.fn()
    const removeSshCredentialRequest = vi.fn()
    const updaterStatusListenerRef: { current: ((status: unknown) => void) | null } = {
      current: null
    }
    const credentialResolvedListenerRef: {
      current: ((data: { requestId: string }) => void) | null
    } = {
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

    vi.doMock('../store', () => ({
      useAppStore: {
        getState: () => ({
          setUpdateStatus,
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
          removeSshCredentialRequest,
          settings: { terminalFontSize: 13 }
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
        worktrees: { onChanged: () => () => {} },
        ui: {
          onOpenSettings: () => () => {},
          onToggleLeftSidebar: () => () => {},
          onToggleRightSidebar: () => () => {},
          onToggleWorktreePalette: () => () => {},
          onOpenQuickOpen: () => () => {},
          onOpenNewWorkspace: () => () => {},
          onJumpToWorktreeIndex: () => () => {},
          onWorktreeHistoryNavigate: () => () => {},
          onActivateWorktree: () => () => {},
          onCreateTerminal: () => () => {},
          onRequestTerminalCreate: () => () => {},
          replyTerminalCreate: () => {},
          onSplitTerminal: () => () => {},
          onRenameTerminal: () => () => {},
          onFocusTerminal: () => () => {},
          onCloseTerminal: () => () => {},
          onSleepWorktree: () => () => {},
          onNewBrowserTab: () => () => {},
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
          onStatus: (listener: (status: unknown) => void) => {
            updaterStatusListenerRef.current = listener
            return () => {}
          },
          onClearDismissal: () => () => {}
        },
        browser: {
          onGuestLoadFailed: () => () => {},
          onOpenLinkInOrcaTab: () => () => {},
          onNavigationUpdate: () => () => {},
          onActivateView: () => () => {}
        },
        rateLimits: {
          get: () => Promise.resolve({ limits: {}, lastUpdatedAt: Date.now() }),
          onUpdate: () => () => {}
        },
        runtime: {
          getTerminalFitOverrides: () => Promise.resolve([]),
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {}
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
          onCredentialResolved: (listener: (data: { requestId: string }) => void) => {
            credentialResolvedListenerRef.current = listener
            return () => {}
          }
        },
        agentStatus: { onSet: () => () => {} }
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    expect(setUpdateStatus).toHaveBeenCalledWith({ state: 'idle' })

    const availableStatus = { state: 'available', version: '1.2.3' }
    if (typeof updaterStatusListenerRef.current !== 'function') {
      throw new Error('Expected updater status listener to be registered')
    }
    updaterStatusListenerRef.current(availableStatus)

    expect(setUpdateStatus).toHaveBeenCalledWith(availableStatus)

    if (typeof credentialResolvedListenerRef.current !== 'function') {
      throw new Error('Expected credential resolved listener to be registered')
    }
    credentialResolvedListenerRef.current({ requestId: 'req-1' })

    expect(removeSshCredentialRequest).toHaveBeenCalledWith('req-1')
  })

  it('clears stale remote PTYs when an SSH connection fully disconnects', async () => {
    const clearTabPtyId = vi.fn()
    const setSshConnectionState = vi.fn()
    const sshStateListenerRef: {
      current: ((data: { targetId: string; state: unknown }) => void) | null
    } = {
      current: null
    }
    const storeState = {
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
      activeTabType: 'terminal',
      editorFontZoomLevel: 0,
      setEditorFontZoomLevel: vi.fn(),
      setRateLimitsFromPush: vi.fn(),
      setSshConnectionState,
      setSshTargetLabels: vi.fn(),
      setPortForwards: vi.fn(),
      clearPortForwards: vi.fn(),
      setDetectedPorts: vi.fn(),
      enqueueSshCredentialRequest: vi.fn(),
      removeSshCredentialRequest: vi.fn(),
      clearRemoteDetectedAgents: vi.fn(),
      clearTabPtyId,
      repos: [{ id: 'repo-1', connectionId: 'conn-1' }],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
      },
      tabsByWorktree: {
        'wt-1': [
          { id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Terminal 1' },
          { id: 'tab-2', ptyId: null, worktreeId: 'wt-1', title: 'Terminal 2' }
        ]
      },
      sshTargetLabels: new Map<string, string>([['conn-1', 'Remote']]),
      settings: { terminalFontSize: 13 }
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
        getState: () => storeState,
        setState: vi.fn((updater: (state: typeof storeState) => typeof storeState) =>
          updater(storeState)
        )
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
        worktrees: { onChanged: () => () => {} },
        ui: {
          onOpenSettings: () => () => {},
          onToggleLeftSidebar: () => () => {},
          onToggleRightSidebar: () => () => {},
          onToggleWorktreePalette: () => () => {},
          onOpenQuickOpen: () => () => {},
          onOpenNewWorkspace: () => () => {},
          onJumpToWorktreeIndex: () => () => {},
          onWorktreeHistoryNavigate: () => () => {},
          onActivateWorktree: () => () => {},
          onCreateTerminal: () => () => {},
          onRequestTerminalCreate: () => () => {},
          replyTerminalCreate: () => {},
          onSplitTerminal: () => () => {},
          onRenameTerminal: () => () => {},
          onFocusTerminal: () => () => {},
          onCloseTerminal: () => () => {},
          onSleepWorktree: () => () => {},
          onNewBrowserTab: () => () => {},
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
          onActivateView: () => () => {}
        },
        rateLimits: {
          get: () => Promise.resolve({ limits: {}, lastUpdatedAt: Date.now() }),
          onUpdate: () => () => {}
        },
        runtime: {
          getTerminalFitOverrides: () => Promise.resolve([]),
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {}
        },
        ssh: {
          listTargets: () => Promise.resolve([]),
          listPortForwards: () => Promise.resolve([]),
          listDetectedPorts: () => Promise.resolve([]),
          getState: () => Promise.resolve(null),
          onStateChanged: (listener: (data: { targetId: string; state: unknown }) => void) => {
            sshStateListenerRef.current = listener
            return () => {}
          },
          onCredentialRequest: () => () => {},
          onCredentialResolved: () => () => {},
          onPortForwardsChanged: () => () => {},
          onDetectedPortsChanged: () => () => {}
        },
        agentStatus: { onSet: () => () => {} }
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof sshStateListenerRef.current !== 'function') {
      throw new Error('Expected ssh state listener to be registered')
    }

    sshStateListenerRef.current({
      targetId: 'conn-1',
      state: { status: 'disconnected', error: null, reconnectAttempt: 0 }
    })

    expect(setSshConnectionState).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ status: 'disconnected' })
    )
    expect(clearTabPtyId).toHaveBeenCalledWith('tab-1')
    expect(clearTabPtyId).not.toHaveBeenCalledWith('tab-2')
    expect(storeState.clearRemoteDetectedAgents).toHaveBeenCalledWith('conn-1')
  })

  it('activates the target worktree when CLI creates a terminal there', async () => {
    const createTab = vi.fn(() => ({ id: 'tab-new' }))
    const setActiveView = vi.fn()
    const setActiveWorktree = vi.fn()
    const setActiveTabType = vi.fn()
    const setActiveTab = vi.fn()
    const revealWorktreeInSidebar = vi.fn()
    const setTabCustomTitle = vi.fn()
    const queueTabStartupCommand = vi.fn()
    const createTerminalListenerRef: {
      current: ((data: { worktreeId: string; command?: string; title?: string }) => void) | null
    } = { current: null }

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
        getState: () => ({
          setUpdateStatus: vi.fn(),
          createTab,
          setActiveView,
          setActiveWorktree,
          markWorktreeVisited: vi.fn(),
          setActiveTabType,
          setActiveTab,
          revealWorktreeInSidebar,
          setTabCustomTitle,
          queueTabStartupCommand,
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
          settings: { terminalFontSize: 13 }
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
        worktrees: { onChanged: () => () => {} },
        ui: {
          onOpenSettings: () => () => {},
          onToggleLeftSidebar: () => () => {},
          onToggleRightSidebar: () => () => {},
          onToggleWorktreePalette: () => () => {},
          onOpenQuickOpen: () => () => {},
          onOpenNewWorkspace: () => () => {},
          onJumpToWorktreeIndex: () => () => {},
          onActivateWorktree: () => () => {},
          onWorktreeHistoryNavigate: () => () => {},
          onCreateTerminal: (
            listener: (data: { worktreeId: string; command?: string; title?: string }) => void
          ) => {
            createTerminalListenerRef.current = listener
            return () => {}
          },
          onRequestTerminalCreate: () => () => {},
          replyTerminalCreate: () => {},
          onSplitTerminal: () => () => {},
          onRenameTerminal: () => () => {},
          onFocusTerminal: () => () => {},
          onCloseTerminal: () => () => {},
          onSleepWorktree: () => () => {},
          onNewBrowserTab: () => () => {},
          onRequestTabCreate: () => () => {},
          replyTabCreate: () => {},
          onRequestTabClose: () => () => {},
          replyTabClose: vi.fn(),
          onRequestTabSetProfile: () => () => {},
          replyTabSetProfile: () => {},
          onNewTerminalTab: () => () => {},
          onCloseActiveTab: () => () => {},
          onSwitchTab: () => () => {},
          onSwitchTabAcrossAllTypes: () => () => {},
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
          onActivateView: () => () => {}
        },
        rateLimits: {
          get: () => Promise.resolve({ limits: {}, lastUpdatedAt: Date.now() }),
          onUpdate: () => () => {}
        },
        runtime: {
          getTerminalFitOverrides: () => Promise.resolve([]),
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {}
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
        agentStatus: { onSet: () => () => {} }
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    if (typeof createTerminalListenerRef.current !== 'function') {
      throw new Error('Expected create-terminal listener to be registered')
    }

    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      title: 'Runner',
      command: 'opencode'
    })

    expect(setActiveView).toHaveBeenCalledWith('terminal')
    expect(setActiveWorktree).toHaveBeenCalledWith('wt-2')
    expect(createTab).toHaveBeenCalledWith('wt-2')
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(setActiveTab).toHaveBeenCalledWith('tab-new')
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(setTabCustomTitle).toHaveBeenCalledWith('tab-new', 'Runner')
    expect(queueTabStartupCommand).toHaveBeenCalledWith('tab-new', { command: 'opencode' })
  })
})

describe('useIpcEvents browser tab close routing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('closes the active browser tab for the requested worktree when main does not provide a tab id', async () => {
    const closeBrowserTab = vi.fn()
    const closeBrowserPage = vi.fn()
    const replyTabClose = vi.fn()
    const tabCloseListenerRef: {
      current:
        | ((data: { requestId: string; tabId: string | null; worktreeId?: string }) => void)
        | null
    } = {
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

    vi.doMock('../store', () => ({
      useAppStore: {
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
          settings: { terminalFontSize: 13 },
          activeBrowserTabId: 'workspace-global',
          activeBrowserTabIdByWorktree: {
            'wt-1': 'workspace-global',
            'wt-2': 'workspace-target'
          },
          browserTabsByWorktree: {
            'wt-1': [{ id: 'workspace-global' }],
            'wt-2': [{ id: 'workspace-target' }]
          },
          browserPagesByWorkspace: {},
          closeBrowserTab,
          closeBrowserPage
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
      dispatchEvent: vi.fn(),
      api: {
        repos: { onChanged: () => () => {} },
        worktrees: { onChanged: () => () => {} },
        ui: {
          onOpenSettings: () => () => {},
          onToggleLeftSidebar: () => () => {},
          onToggleRightSidebar: () => () => {},
          onToggleWorktreePalette: () => () => {},
          onOpenQuickOpen: () => () => {},
          onOpenNewWorkspace: () => () => {},
          onJumpToWorktreeIndex: () => () => {},
          onWorktreeHistoryNavigate: () => () => {},
          onActivateWorktree: () => () => {},
          onCreateTerminal: () => () => {},
          onRequestTerminalCreate: () => () => {},
          replyTerminalCreate: () => {},
          onSplitTerminal: () => () => {},
          onRenameTerminal: () => () => {},
          onFocusTerminal: () => () => {},
          onCloseTerminal: () => () => {},
          onSleepWorktree: () => () => {},
          onNewBrowserTab: () => () => {},
          onRequestTabCreate: () => () => {},
          replyTabCreate: () => {},
          onRequestTabClose: (
            listener: (data: {
              requestId: string
              tabId: string | null
              worktreeId?: string
            }) => void
          ) => {
            tabCloseListenerRef.current = listener
            return () => {}
          },
          replyTabClose,
          onRequestTabSetProfile: () => () => {},
          replyTabSetProfile: () => {},
          onNewTerminalTab: () => () => {},
          onCloseActiveTab: () => () => {},
          onSwitchTab: () => () => {},
          onSwitchTabAcrossAllTypes: () => () => {},
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
          onActivateView: () => () => {}
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
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {}
        },
        agentStatus: { onSet: () => () => {} }
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    expect(tabCloseListenerRef.current).toBeTypeOf('function')
    tabCloseListenerRef.current?.({
      requestId: 'req-1',
      tabId: null,
      worktreeId: 'wt-2'
    })

    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-target')
    expect(closeBrowserPage).not.toHaveBeenCalled()
    expect(replyTabClose).toHaveBeenCalledWith({ requestId: 'req-1' })
  })

  it('closes only the requested browser page when a workspace has multiple pages', async () => {
    const closeBrowserTab = vi.fn()
    const closeBrowserPage = vi.fn()
    const replyTabClose = vi.fn()
    const tabCloseListenerRef: {
      current:
        | ((data: { requestId: string; tabId: string | null; worktreeId?: string }) => void)
        | null
    } = {
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

    vi.doMock('../store', () => ({
      useAppStore: {
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
          settings: { terminalFontSize: 13 },
          activeBrowserTabId: 'workspace-1',
          activeBrowserTabIdByWorktree: { 'wt-1': 'workspace-1' },
          browserTabsByWorktree: {
            'wt-1': [{ id: 'workspace-1' }]
          },
          browserPagesByWorkspace: {
            'workspace-1': [
              { id: 'page-1', workspaceId: 'workspace-1' },
              { id: 'page-2', workspaceId: 'workspace-1' }
            ]
          },
          closeBrowserTab,
          closeBrowserPage
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
      dispatchEvent: vi.fn(),
      api: {
        repos: { onChanged: () => () => {} },
        worktrees: { onChanged: () => () => {} },
        ui: {
          onOpenSettings: () => () => {},
          onToggleLeftSidebar: () => () => {},
          onToggleRightSidebar: () => () => {},
          onToggleWorktreePalette: () => () => {},
          onOpenQuickOpen: () => () => {},
          onOpenNewWorkspace: () => () => {},
          onJumpToWorktreeIndex: () => () => {},
          onWorktreeHistoryNavigate: () => () => {},
          onActivateWorktree: () => () => {},
          onCreateTerminal: () => () => {},
          onRequestTerminalCreate: () => () => {},
          replyTerminalCreate: () => {},
          onSplitTerminal: () => () => {},
          onRenameTerminal: () => () => {},
          onFocusTerminal: () => () => {},
          onCloseTerminal: () => () => {},
          onSleepWorktree: () => () => {},
          onNewBrowserTab: () => () => {},
          onRequestTabCreate: () => () => {},
          replyTabCreate: () => {},
          onRequestTabClose: (
            listener: (data: {
              requestId: string
              tabId: string | null
              worktreeId?: string
            }) => void
          ) => {
            tabCloseListenerRef.current = listener
            return () => {}
          },
          replyTabClose,
          onRequestTabSetProfile: () => () => {},
          replyTabSetProfile: () => {},
          onNewTerminalTab: () => () => {},
          onCloseActiveTab: () => () => {},
          onSwitchTab: () => () => {},
          onSwitchTabAcrossAllTypes: () => () => {},
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
          onActivateView: () => () => {}
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
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {}
        },
        agentStatus: { onSet: () => () => {} }
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    tabCloseListenerRef.current?.({
      requestId: 'req-2',
      tabId: 'page-2'
    })

    expect(closeBrowserPage).toHaveBeenCalledWith('page-2')
    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(replyTabClose).toHaveBeenCalledWith({ requestId: 'req-2' })
  })

  it('rejects explicit unknown browser page ids instead of reporting success', async () => {
    const closeBrowserTab = vi.fn()
    const closeBrowserPage = vi.fn()
    const replyTabClose = vi.fn()
    const tabCloseListenerRef: {
      current:
        | ((data: { requestId: string; tabId: string | null; worktreeId?: string }) => void)
        | null
    } = {
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

    vi.doMock('../store', () => ({
      useAppStore: {
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
          settings: { terminalFontSize: 13 },
          activeBrowserTabId: 'workspace-1',
          activeBrowserTabIdByWorktree: { 'wt-1': 'workspace-1' },
          browserTabsByWorktree: {
            'wt-1': [{ id: 'workspace-1' }]
          },
          browserPagesByWorkspace: {
            'workspace-1': [{ id: 'page-1', workspaceId: 'workspace-1' }]
          },
          closeBrowserTab,
          closeBrowserPage
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
      dispatchEvent: vi.fn(),
      api: {
        repos: { onChanged: () => () => {} },
        worktrees: { onChanged: () => () => {} },
        ui: {
          onOpenSettings: () => () => {},
          onToggleLeftSidebar: () => () => {},
          onToggleRightSidebar: () => () => {},
          onToggleWorktreePalette: () => () => {},
          onOpenQuickOpen: () => () => {},
          onOpenNewWorkspace: () => () => {},
          onJumpToWorktreeIndex: () => () => {},
          onWorktreeHistoryNavigate: () => () => {},
          onActivateWorktree: () => () => {},
          onCreateTerminal: () => () => {},
          onRequestTerminalCreate: () => () => {},
          replyTerminalCreate: () => {},
          onSplitTerminal: () => () => {},
          onRenameTerminal: () => () => {},
          onFocusTerminal: () => () => {},
          onCloseTerminal: () => () => {},
          onSleepWorktree: () => () => {},
          onNewBrowserTab: () => () => {},
          onRequestTabCreate: () => () => {},
          replyTabCreate: () => {},
          onRequestTabClose: (
            listener: (data: {
              requestId: string
              tabId: string | null
              worktreeId?: string
            }) => void
          ) => {
            tabCloseListenerRef.current = listener
            return () => {}
          },
          replyTabClose,
          onRequestTabSetProfile: () => () => {},
          replyTabSetProfile: () => {},
          onNewTerminalTab: () => () => {},
          onCloseActiveTab: () => () => {},
          onSwitchTab: () => () => {},
          onSwitchTabAcrossAllTypes: () => () => {},
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
          onActivateView: () => () => {}
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
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {}
        },
        agentStatus: { onSet: () => () => {} }
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    tabCloseListenerRef.current?.({
      requestId: 'req-3',
      tabId: 'missing-page'
    })

    expect(closeBrowserPage).not.toHaveBeenCalled()
    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(replyTabClose).toHaveBeenCalledWith({
      requestId: 'req-3',
      error: 'Browser tab missing-page not found'
    })
  })
})

describe('useIpcEvents shortcut hint clearing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('clears modifier hints for main-process-forwarded shortcuts', async () => {
    const toggleLeftSidebarRef: { current: (() => void) | null } = { current: null }
    const jumpToWorktreeRef: { current: ((index: number) => void) | null } = { current: null }
    const toggleSidebar = vi.fn()
    const dispatchEvent = vi.fn()
    const activateAndRevealWorktree = vi.fn()

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
        getState: () => ({
          toggleSidebar,
          toggleRightSidebar: vi.fn(),
          activeModal: 'none',
          closeModal: vi.fn(),
          openModal: vi.fn(),
          activeView: 'terminal',
          activeWorktreeId: 'wt-1',
          statusBarVisible: true,
          setStatusBarVisible: vi.fn(),
          fetchRepos: vi.fn(),
          fetchWorktrees: vi.fn(),
          setActiveView: vi.fn(),
          setActiveRepo: vi.fn(),
          setActiveWorktree: vi.fn(),
          revealWorktreeInSidebar: vi.fn(),
          setIsFullScreen: vi.fn(),
          updateBrowserPageState: vi.fn(),
          createBrowserTab: vi.fn(),
          browserDefaultUrl: 'about:blank',
          createTab: vi.fn(),
          setActiveTabType: vi.fn(),
          tabsByWorktree: {},
          openFiles: [],
          browserTabsByWorktree: {},
          tabBarOrderByWorktree: {},
          setTabBarOrder: vi.fn(),
          activeBrowserTabId: null,
          closeBrowserTab: vi.fn(),
          activeTabType: 'terminal',
          editorFontZoomLevel: 0,
          setUpdateStatus: vi.fn(),
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
          tabs: [],
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
      getVisibleWorktreeIds: () => ['wt-1', 'wt-2']
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
      dispatchEvent,
      api: {
        repos: { onChanged: () => () => {} },
        worktrees: { onChanged: () => () => {} },
        ui: {
          onOpenSettings: () => () => {},
          onToggleLeftSidebar: (listener: () => void) => {
            toggleLeftSidebarRef.current = listener
            return () => {}
          },
          onToggleRightSidebar: () => () => {},
          onToggleWorktreePalette: () => () => {},
          onOpenQuickOpen: () => () => {},
          onOpenNewWorkspace: () => () => {},
          onJumpToWorktreeIndex: (listener: (index: number) => void) => {
            jumpToWorktreeRef.current = listener
            return () => {}
          },
          onWorktreeHistoryNavigate: () => () => {},
          onActivateWorktree: () => () => {},
          onCreateTerminal: () => () => {},
          onRequestTerminalCreate: () => () => {},
          replyTerminalCreate: () => {},
          onSplitTerminal: () => () => {},
          onRenameTerminal: () => () => {},
          onFocusTerminal: () => () => {},
          onCloseTerminal: () => () => {},
          onSleepWorktree: () => () => {},
          onNewBrowserTab: () => () => {},
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
          onActivateView: () => () => {}
        },
        rateLimits: {
          get: () => Promise.resolve({ limits: {}, lastUpdatedAt: Date.now() }),
          onUpdate: () => () => {}
        },
        runtime: {
          getTerminalFitOverrides: () => Promise.resolve([]),
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {}
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
        agentStatus: { onSet: () => () => {} }
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof toggleLeftSidebarRef.current !== 'function') {
      throw new Error('Expected toggle-left-sidebar listener to be registered')
    }
    if (typeof jumpToWorktreeRef.current !== 'function') {
      throw new Error('Expected jump-to-worktree listener to be registered')
    }

    toggleLeftSidebarRef.current()
    jumpToWorktreeRef.current(1)

    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'orca:clear-modifier-hints' })
    )
    expect(dispatchEvent).toHaveBeenCalledTimes(2)
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-2')
  })
})

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
  it('routes CLI-driven activation through activateAndRevealWorktree so back/forward history is recorded', async () => {
    const activateAndRevealWorktree = vi.fn()
    const fetchWorktrees = vi.fn().mockResolvedValue(undefined)
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
        getState: () => ({
          fetchRepos: vi.fn(),
          fetchWorktrees,
          setUpdateStatus: vi.fn(),
          activeModal: null,
          closeModal: vi.fn(),
          openModal: vi.fn(),
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
        worktrees: { onChanged: () => () => {} },
        ui: {
          onOpenSettings: () => () => {},
          onToggleLeftSidebar: () => () => {},
          onToggleRightSidebar: () => () => {},
          onToggleWorktreePalette: () => () => {},
          onOpenQuickOpen: () => () => {},
          onOpenNewWorkspace: () => () => {},
          onJumpToWorktreeIndex: () => () => {},
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
          replyTerminalCreate: () => {},
          onSplitTerminal: () => () => {},
          onRenameTerminal: () => () => {},
          onFocusTerminal: () => () => {},
          onCloseTerminal: () => () => {},
          onSleepWorktree: () => () => {},
          onNewBrowserTab: () => () => {},
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
          onActivateView: () => () => {}
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
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {}
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
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-new', { setup })
  })
})
