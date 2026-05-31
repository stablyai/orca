/* eslint-disable max-lines -- Why: this test file keeps the hook wiring mocks close to the assertions so IPC event behavior stays understandable and maintainable. */
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildNewWorkspaceShortcutModalData,
  resolveBrowserSessionTabTarget,
  resolveZoomTarget
} from './useIpcEvents'
import { makePaneKey } from '../../../shared/stable-pane-id'

const FUTURE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const STALE_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const ORPHAN_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const TAB_1_LEAF_ID = '44444444-4444-4444-8444-444444444444'
const FUTURE_PANE_KEY = makePaneKey('tab-future', FUTURE_LEAF_ID)
const STALE_PANE_KEY = makePaneKey('tab-future', STALE_LEAF_ID)
const ORPHAN_PANE_KEY = makePaneKey('tab-orphan', ORPHAN_LEAF_ID)
const TAB_1_PANE_KEY = makePaneKey('tab-1', TAB_1_LEAF_ID)

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

describe('resolveBrowserSessionTabTarget', () => {
  it('resolves unified browser tabs to their browser workspace', () => {
    expect(
      resolveBrowserSessionTabTarget(
        {
          unifiedTabsByWorktree: {
            'wt-1': [
              {
                id: 'unified-browser',
                groupId: 'group-1',
                contentType: 'browser',
                entityId: 'browser-workspace'
              }
            ]
          },
          browserTabsByWorktree: {
            'wt-1': [{ id: 'browser-workspace' }]
          }
        } as never,
        'wt-1',
        'unified-browser'
      )
    ).toEqual({
      kind: 'unified-browser',
      unifiedTabId: 'unified-browser',
      workspaceId: 'browser-workspace',
      groupId: 'group-1'
    })
  })

  it('resolves fallback mobile browser tabs by workspace id', () => {
    expect(
      resolveBrowserSessionTabTarget(
        {
          unifiedTabsByWorktree: { 'wt-1': [] },
          browserTabsByWorktree: {
            'wt-1': [{ id: 'browser-workspace' }]
          }
        } as never,
        'wt-1',
        'browser-workspace'
      )
    ).toEqual({
      kind: 'fallback-browser',
      workspaceId: 'browser-workspace'
    })
  })
})

describe('buildNewWorkspaceShortcutModalData', () => {
  it('carries the active Linear issue into the Cmd+N composer', () => {
    const data = buildNewWorkspaceShortcutModalData({
      activeView: 'tasks',
      taskPageData: {
        openLinearIssue: {
          id: 'issue-1',
          identifier: 'ENG-123',
          title: 'Fix Linear context handoff',
          description: 'Pass the active issue into the agent prompt.',
          url: 'https://linear.app/acme/issue/ENG-123/fix-linear-context-handoff',
          state: { name: 'Todo', type: 'unstarted', color: '#999999' },
          team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
          labels: [],
          labelIds: [],
          priority: 3,
          estimate: null,
          updatedAt: '2026-05-29T12:00:00.000Z'
        }
      }
    } as never)

    expect(data.telemetrySource).toBe('shortcut')
    expect(data.prefilledName).toBe('fix-linear-context-handoff')
    expect(data.linkedWorkItem).toMatchObject({
      type: 'issue',
      number: 0,
      title: 'Fix Linear context handoff',
      url: 'https://linear.app/acme/issue/ENG-123/fix-linear-context-handoff',
      linearIdentifier: 'ENG-123',
      linkedContext: {
        provider: 'linear',
        version: 1
      }
    })
    expect(data.linkedWorkItem?.linkedContext?.renderedText).toContain('Identifier: ENG-123')
    expect(data.linkedWorkItem?.linkedContext?.renderedText).toContain(
      'URL: https://linear.app/acme/issue/ENG-123/fix-linear-context-handoff'
    )
  })

  it('does not reuse stale task context outside the Tasks view', () => {
    const data = buildNewWorkspaceShortcutModalData({
      activeView: 'terminal',
      taskPageData: {
        openLinearIssue: {
          id: 'issue-1',
          identifier: 'ENG-123',
          title: 'Fix Linear context handoff',
          url: 'https://linear.app/acme/issue/ENG-123/fix-linear-context-handoff',
          state: { name: 'Todo', type: 'unstarted', color: '#999999' },
          team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
          labels: [],
          labelIds: [],
          priority: 3,
          estimate: null,
          updatedAt: '2026-05-29T12:00:00.000Z'
        }
      }
    } as never)

    expect(data).toEqual({ telemetrySource: 'shortcut' })
  })
})

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
            url: string
            sessionProfileId?: string
          }) => void)
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
        'wt-1': [{ id: 'workspace-active', activePageId: 'page-active', pageIds: ['page-active'] }]
      },
      browserPagesByWorkspace: {
        'workspace-active': [{ id: 'page-active', worktreeId: 'wt-1' }]
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
        (_worktreeId: string, _url: string, options: { activate?: boolean }) => {
          const workspace = { id: 'workspace-new', activePageId: 'page-new', pageIds: ['page-new'] }
          state.browserTabsByWorktree['wt-1'].push(workspace)
          state.browserPagesByWorkspace['workspace-new'] = [{ id: 'page-new', worktreeId: 'wt-1' }]
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
    vi.doMock('@/components/browser-pane/browser-automation-visibility', () => ({
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
          onBaseStatus: () => () => {},
          onRemoteBranchConflict: () => () => {}
        },
        ui: {
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
          onActivateWorktree: () => () => {},
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

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    requestTabCreateListenerRef.current?.({
      requestId: 'req-create',
      worktreeId: 'wt-1',
      url: 'https://example.com'
    })

    expect(acquireBrowserAutomationVisibility).toHaveBeenCalledWith('page-new')
    expect(acquireBrowserAutomationVisibility).not.toHaveBeenCalledWith('page-active')
    expect(replyTabCreate).toHaveBeenCalledWith({
      requestId: 'req-create',
      browserPageId: 'page-new'
    })
    expect(dispatchEvent).toHaveBeenCalled()
    expect(releaseBrowserAutomationVisibility).not.toHaveBeenCalled()
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
        subscribe: vi.fn(() => () => {}),
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
        worktrees: {
          onChanged: () => () => {},
          onBaseStatus: () => () => {},
          onRemoteBranchConflict: () => () => {}
        },
        ui: {
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
          onActivateWorktree: () => () => {},
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
          onActivateView: () => () => {},
          onPaneFocus: () => () => {}
        },
        rateLimits: {
          get: () => Promise.resolve({ limits: {}, lastUpdatedAt: Date.now() }),
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
    const setSshTargetsMetadata = vi.fn()
    const clearRemovedSshTargetState = vi.fn()
    const pendingListTargets: {
      resolve: (targets: { id: string; label: string }[]) => void
      reject: (err: unknown) => void
    }[] = []
    let listTargetsCallCount = 0
    const listTargets = vi.fn(() => {
      listTargetsCallCount += 1
      if (listTargetsCallCount === 1) {
        return Promise.resolve([{ id: 'conn-1', label: 'Remote' }])
      }
      return new Promise<{ id: string; label: string }[]>((resolve, reject) => {
        pendingListTargets.push({ resolve, reject })
      })
    })
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
      setSshTargetsMetadata,
      setPortForwards: vi.fn(),
      clearPortForwards: vi.fn(),
      setDetectedPorts: vi.fn(),
      enqueueSshCredentialRequest: vi.fn(),
      removeSshCredentialRequest: vi.fn(),
      clearRemoteDetectedAgents: vi.fn(),
      clearRemovedSshTargetState,
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
        subscribe: vi.fn(() => () => {}),
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
        worktrees: {
          onChanged: () => () => {},
          onBaseStatus: () => () => {},
          onRemoteBranchConflict: () => () => {}
        },
        ui: {
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
          onActivateWorktree: () => () => {},
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
        runtime: {
          getTerminalFitOverrides: () => Promise.resolve([]),
          getTerminalDrivers: () => Promise.resolve([]),
          getBrowserDrivers: () => Promise.resolve([]),
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {},
          onBrowserDriverChanged: () => () => {}
        },
        ssh: {
          listTargets,
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

    setSshConnectionState.mockClear()
    sshStateListenerRef.current({
      targetId: 'conn-removed',
      state: { status: 'disconnected', error: null, reconnectAttempt: 0 }
    })
    expect(pendingListTargets).toHaveLength(1)
    pendingListTargets.shift()!.resolve([])
    await Promise.resolve()
    await Promise.resolve()

    expect(setSshConnectionState).not.toHaveBeenCalled()
    expect(clearRemovedSshTargetState).toHaveBeenCalledWith('conn-removed')

    clearRemovedSshTargetState.mockClear()
    setSshConnectionState.mockClear()

    const connectingState = {
      targetId: 'conn-new',
      status: 'connecting',
      error: null,
      reconnectAttempt: 0
    }
    const errorState = {
      targetId: 'conn-new',
      status: 'error',
      error: 'Connection failed',
      reconnectAttempt: 0
    }
    sshStateListenerRef.current({
      targetId: 'conn-new',
      state: connectingState
    })
    sshStateListenerRef.current({
      targetId: 'conn-new',
      state: errorState
    })

    expect(pendingListTargets).toHaveLength(2)
    const resolveConnectingTargets = pendingListTargets.shift()!.resolve
    const resolveErrorTargets = pendingListTargets.shift()!.resolve
    const targets = [{ id: 'conn-new', label: 'New remote' }]
    resolveErrorTargets(targets)
    await Promise.resolve()
    await Promise.resolve()
    resolveConnectingTargets(targets)
    await Promise.resolve()
    await Promise.resolve()

    expect(clearRemovedSshTargetState).not.toHaveBeenCalled()
    expect(setSshTargetsMetadata).toHaveBeenCalledWith(targets)
    expect(setSshConnectionState).toHaveBeenCalledTimes(1)
    expect(setSshConnectionState).toHaveBeenCalledWith('conn-new', errorState)

    setSshTargetsMetadata.mockClear()
    setSshConnectionState.mockClear()

    const staleState = {
      targetId: 'conn-known-late',
      status: 'connecting',
      error: null,
      reconnectAttempt: 0
    }
    const latestState = {
      targetId: 'conn-known-late',
      status: 'error',
      error: 'Connection failed',
      reconnectAttempt: 1
    }
    sshStateListenerRef.current({
      targetId: 'conn-known-late',
      state: staleState
    })
    expect(pendingListTargets).toHaveLength(1)
    storeState.sshTargetLabels.set('conn-known-late', 'Late remote')
    sshStateListenerRef.current({
      targetId: 'conn-known-late',
      state: latestState
    })
    pendingListTargets.shift()!.resolve([{ id: 'conn-known-late', label: 'Late remote' }])
    await Promise.resolve()
    await Promise.resolve()

    expect(setSshTargetsMetadata).not.toHaveBeenCalled()
    expect(setSshConnectionState).toHaveBeenCalledTimes(1)
    expect(setSshConnectionState).toHaveBeenCalledWith('conn-known-late', latestState)

    setSshConnectionState.mockClear()
    const refreshFailureState = {
      targetId: 'conn-refresh-failure',
      status: 'connecting',
      error: null,
      reconnectAttempt: 0
    }
    sshStateListenerRef.current({
      targetId: 'conn-refresh-failure',
      state: refreshFailureState
    })
    expect(pendingListTargets).toHaveLength(1)
    pendingListTargets.shift()!.reject(new Error('first refresh failed'))
    await Promise.resolve()
    expect(pendingListTargets).toHaveLength(1)
    pendingListTargets.shift()!.reject(new Error('second refresh failed'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(setSshConnectionState).toHaveBeenCalledTimes(1)
    expect(setSshConnectionState).toHaveBeenCalledWith('conn-refresh-failure', refreshFailureState)
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
    const updateTabPtyId = vi.fn()
    const setTabLayout = vi.fn()
    const setTabBarOrder = vi.fn()
    const replyTerminalCreate = vi.fn()
    const dispatchEvent = vi.fn()
    const createFloatingWorkspaceTerminalTab = vi.fn()
    const createWebRuntimeSessionTerminal = vi.fn().mockResolvedValue(false)
    let floatingPanelFocused = false
    const storeState = {
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
      updateTabPtyId,
      setTabLayout,
      tabsByWorktree: {} as Record<string, { id: string; ptyId?: string | null; title?: string }[]>,
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
      settings: { terminalFontSize: 13 }
    }
    const createTerminalListenerRef: {
      current:
        | ((data: {
            requestId?: string
            worktreeId: string
            command?: string
            title?: string
            ptyId?: string
            activate?: boolean
            tabId?: string
            leafId?: string
            splitFromLeafId?: string
            splitDirection?: 'horizontal' | 'vertical'
          }) => void)
        | null
    } = { current: null }
    const requestTerminalCreateListenerRef: {
      current:
        | ((data: {
            requestId: string
            worktreeId?: string
            afterTabId?: string
            targetGroupId?: string
            command?: string
            title?: string
            activate?: boolean
          }) => void)
        | null
    } = { current: null }
    const newTerminalTabListenerRef: { current: (() => void) | null } = { current: null }

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
      isFloatingWorkspacePanelFocused: () => floatingPanelFocused
    }))
    vi.doMock('@/runtime/web-runtime-session', () => ({
      activateWebRuntimeSessionTab: vi.fn(),
      closeWebRuntimeSessionTab: vi.fn(),
      createWebRuntimeSessionBrowserTab: vi.fn().mockResolvedValue(false),
      createWebRuntimeSessionTerminal,
      isWebRuntimeSessionActive: vi.fn(() => false)
    }))
    vi.doMock('@/lib/focus-terminal-tab-surface', () => ({
      focusTerminalTabSurface: vi.fn()
    }))

    vi.stubGlobal('window', {
      dispatchEvent,
      api: {
        repos: { onChanged: () => () => {} },
        worktrees: {
          onChanged: () => () => {},
          onBaseStatus: () => () => {},
          onRemoteBranchConflict: () => () => {}
        },
        ui: {
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
          onActivateWorktree: () => () => {},
          onWorktreeHistoryNavigate: () => () => {},
          onCreateTerminal: (
            listener: (data: {
              requestId?: string
              worktreeId: string
              command?: string
              title?: string
              ptyId?: string
              activate?: boolean
              tabId?: string
              leafId?: string
              splitFromLeafId?: string
              splitDirection?: 'horizontal' | 'vertical'
            }) => void
          ) => {
            createTerminalListenerRef.current = listener
            return () => {}
          },
          onRequestTerminalCreate: (
            listener: (data: {
              requestId: string
              worktreeId?: string
              afterTabId?: string
              targetGroupId?: string
              command?: string
              title?: string
              activate?: boolean
            }) => void
          ) => {
            requestTerminalCreateListenerRef.current = listener
            return () => {}
          },
          replyTerminalCreate,
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
          replyTabClose: vi.fn(),
          onRequestTabSetProfile: () => () => {},
          replyTabSetProfile: () => {},
          onNewTerminalTab: (listener: () => void) => {
            newTerminalTabListenerRef.current = listener
            return () => {}
          },
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
    if (typeof newTerminalTabListenerRef.current !== 'function') {
      throw new Error('Expected new-terminal-tab listener to be registered')
    }

    floatingPanelFocused = true
    newTerminalTabListenerRef.current()
    expect(createFloatingWorkspaceTerminalTab).toHaveBeenCalledWith(storeState)
    expect(createTab).not.toHaveBeenCalled()

    floatingPanelFocused = false
    createFloatingWorkspaceTerminalTab.mockClear()
    createTab.mockClear()
    newTerminalTabListenerRef.current()
    await Promise.resolve()
    await Promise.resolve()
    expect(createFloatingWorkspaceTerminalTab).not.toHaveBeenCalled()
    expect(createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      activate: true
    })
    expect(createTab).toHaveBeenCalledWith('wt-1')
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')

    createWebRuntimeSessionTerminal.mockClear()
    createTab.mockClear()
    setActiveTabType.mockClear()

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
    expect(setTabCustomTitle).toHaveBeenCalledWith('tab-new', 'Runner', {
      recordInteraction: false
    })
    expect(queueTabStartupCommand).toHaveBeenCalledWith('tab-new', { command: 'opencode' })

    if (typeof requestTerminalCreateListenerRef.current !== 'function') {
      throw new Error('Expected request-terminal-create listener to be registered')
    }

    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    setTabCustomTitle.mockClear()
    queueTabStartupCommand.mockClear()
    requestTerminalCreateListenerRef.current({
      requestId: 'req-renderer-backed',
      worktreeId: 'wt-2',
      targetGroupId: 'group-left',
      title: 'Codex',
      command: 'codex',
      activate: false
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', 'group-left', undefined, {
      activate: false,
      recordInteraction: false
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).not.toHaveBeenCalled()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-2' }
      })
    )
    expect(setTabCustomTitle).toHaveBeenCalledWith('tab-new', 'Codex', {
      recordInteraction: false
    })
    expect(queueTabStartupCommand).toHaveBeenCalledWith('tab-new', { command: 'codex' })
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-renderer-backed',
      tabId: 'tab-new',
      title: 'Codex'
    })

    createTab.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-bg'
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-bg',
      activate: true
    })

    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-bg-2',
      activate: false,
      tabId: 'tab-cli-bg'
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-bg-2',
      activate: false,
      id: 'tab-cli-bg'
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).not.toHaveBeenCalled()

    storeState.tabsByWorktree = {
      'wt-2': [{ id: 'tab-existing', ptyId: 'pty-bg', title: 'Terminal 1' }]
    }
    storeState.ptyIdsByTabId = { 'tab-existing': ['pty-bg'] }
    createTab.mockClear()
    setActiveTab.mockClear()
    setTabCustomTitle.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-bg',
      title: 'Runtime title'
    })

    expect(createTab).not.toHaveBeenCalled()
    expect(setActiveTab).toHaveBeenCalledWith('tab-existing')
    expect(setTabCustomTitle).not.toHaveBeenCalled()

    createTerminalListenerRef.current({
      requestId: 'req-reveal',
      worktreeId: 'wt-2',
      ptyId: 'pty-bg'
    })

    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-reveal',
      tabId: 'tab-existing',
      title: 'Terminal 1'
    })

    storeState.tabsByWorktree = {
      'wt-2': [{ id: 'tab-existing', ptyId: 'pty-bg', title: 'Terminal 1' }]
    }
    storeState.ptyIdsByTabId = { 'tab-existing': ['pty-bg'] }
    storeState.terminalLayoutsByTabId = {
      'tab-existing': {
        root: { type: 'leaf', leafId: 'leaf-source' },
        activeLeafId: 'leaf-source',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-source': 'pty-bg' }
      }
    }
    createTab.mockClear()
    updateTabPtyId.mockClear()
    setTabLayout.mockClear()
    replyTerminalCreate.mockClear()
    createTerminalListenerRef.current({
      requestId: 'req-split',
      worktreeId: 'wt-2',
      ptyId: 'pty-split',
      tabId: 'tab-existing',
      leafId: 'leaf-split',
      splitFromLeafId: 'leaf-source',
      splitDirection: 'vertical'
    })

    expect(createTab).not.toHaveBeenCalled()
    expect(updateTabPtyId).toHaveBeenCalledWith('tab-existing', 'pty-split')
    expect(setTabLayout).toHaveBeenCalledWith('tab-existing', {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'leaf-source' },
        second: { type: 'leaf', leafId: 'leaf-split' },
        ratio: 0.5
      },
      activeLeafId: 'leaf-split',
      expandedLeafId: null,
      ptyIdsByLeafId: {
        'leaf-source': 'pty-bg',
        'leaf-split': 'pty-split'
      }
    })
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-split-terminal-pane',
        detail: {
          tabId: 'tab-existing',
          paneRuntimeId: -1,
          direction: 'vertical',
          sourceLeafId: 'leaf-source',
          newLeafId: 'leaf-split',
          ptyId: 'pty-split'
        }
      })
    )
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-split',
      tabId: 'tab-existing',
      title: 'Terminal 1'
    })

    storeState.terminalLayoutsByTabId = {
      'tab-existing': {
        root: { type: 'leaf', leafId: 'leaf-source' },
        activeLeafId: 'leaf-source',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-source': 'pty-bg' }
      }
    }
    updateTabPtyId.mockClear()
    setTabLayout.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-split-background',
      tabId: 'tab-existing',
      leafId: 'leaf-split-background',
      splitFromLeafId: 'leaf-source',
      splitDirection: 'vertical',
      activate: false
    })

    expect(updateTabPtyId).toHaveBeenCalledWith('tab-existing', 'pty-split-background')
    expect(setTabLayout).toHaveBeenCalledWith('tab-existing', {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'leaf-source' },
        second: { type: 'leaf', leafId: 'leaf-split-background' },
        ratio: 0.5
      },
      activeLeafId: 'leaf-source',
      expandedLeafId: null,
      ptyIdsByLeafId: {
        'leaf-source': 'pty-bg',
        'leaf-split-background': 'pty-split-background'
      }
    })

    const splitLayout = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'leaf-source' },
        second: { type: 'leaf', leafId: 'leaf-split' },
        ratio: 0.5
      },
      activeLeafId: 'leaf-split',
      expandedLeafId: null,
      ptyIdsByLeafId: {
        'leaf-source': 'pty-bg',
        'leaf-split': 'pty-split'
      }
    }
    storeState.ptyIdsByTabId = { 'tab-existing': ['pty-bg', 'pty-split'] }
    storeState.terminalLayoutsByTabId = { 'tab-existing': splitLayout }
    updateTabPtyId.mockClear()
    setTabLayout.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-split',
      tabId: 'tab-existing',
      leafId: 'leaf-split'
    })

    expect(updateTabPtyId).toHaveBeenCalledWith('tab-existing', 'pty-split')
    expect(setTabLayout).toHaveBeenCalledWith('tab-existing', splitLayout)
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
        worktrees: {
          onChanged: () => () => {},
          onBaseStatus: () => () => {},
          onRemoteBranchConflict: () => () => {}
        },
        ui: {
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
          onActivateWorktree: () => () => {},
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
          onBrowserDriverChanged: () => () => {}
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
        worktrees: {
          onChanged: () => () => {},
          onBaseStatus: () => () => {},
          onRemoteBranchConflict: () => () => {}
        },
        ui: {
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
          onActivateWorktree: () => () => {},
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
          onBrowserDriverChanged: () => () => {}
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
        worktrees: {
          onChanged: () => () => {},
          onBaseStatus: () => () => {},
          onRemoteBranchConflict: () => () => {}
        },
        ui: {
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
          onActivateWorktree: () => () => {},
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
          onBrowserDriverChanged: () => () => {}
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
        worktrees: {
          onChanged: () => () => {},
          onBaseStatus: () => () => {},
          onRemoteBranchConflict: () => () => {}
        },
        ui: {
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
          onBrowserDriverChanged: () => () => {}
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
      sidebarRevealBehavior: 'auto'
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
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-existing', {})
  })
})

// Why: end-to-end exercise of startup agent-status restoration through
// useIpcEvents itself. The main process owns the durable cache; the renderer
// pulls a snapshot only after workspace tabs are ready so startup pushes
// cannot be lost while local state is still empty.
describe('useIpcEvents agent status snapshot integration', () => {
  type AgentStatusSetData = {
    paneKey: string
    tabId?: string
    worktreeId?: string
    state: 'working' | 'blocked' | 'waiting' | 'done'
    prompt?: string
    agentType?: string
    toolName?: string
    toolInput?: string
    lastAssistantMessage?: string
    interrupted?: boolean
    connectionId?: string | null
    receivedAt: number
    stateStartedAt: number
  }
  type StoreLike = Record<string, unknown>
  type StoreSubscribeListener = (state: StoreLike) => void
  type MobileFitEvent = {
    ptyId: string
    mode: 'mobile-fit' | 'desktop-fit'
    cols: number
    rows: number
  }
  type MobileFitListener = (event: MobileFitEvent) => void
  type MobileDriverListener = (event: {
    ptyId: string
    driver: { kind: 'mobile'; clientId: string }
  }) => void
  type MobileBrowserDriverListener = (event: {
    browserPageId: string
    driver: { kind: 'mobile'; clientId: string }
  }) => void

  function buildStoreState(overrides: StoreLike): StoreLike {
    // Why: copy the defensive set of getState() fields the hook touches during
    // mount so individual tests only need to override workspaceSessionReady,
    // tabsByWorktree, and setAgentStatus.
    return {
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
      updateWorktreeBaseStatus: vi.fn(),
      updateWorktreeRemoteBranchConflict: vi.fn(),
      setSshConnectionState: vi.fn(),
      setSshTargetLabels: vi.fn(),
      setPortForwards: vi.fn(),
      clearPortForwards: vi.fn(),
      setDetectedPorts: vi.fn(),
      enqueueSshCredentialRequest: vi.fn(),
      removeSshCredentialRequest: vi.fn(),
      clearTabPtyId: vi.fn(),
      runtimePaneTitlesByTabId: {},
      terminalLayoutsByTabId: {},
      agentStatusByPaneKey: {},
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      workspaceSessionReady: false,
      settings: { terminalFontSize: 13 },
      ...overrides
    }
  }

  function buildWindowApi(args: {
    onSet: (cb: (data: AgentStatusSetData) => void) => () => void
    getSnapshot?: () => Promise<AgentStatusSetData[]>
    drop?: (paneKey: string) => void
    remoteWorkspace?: Record<string, unknown>
    runtime?: Record<string, unknown>
  }): Record<string, unknown> {
    return {
      api: {
        repos: { onChanged: () => () => {} },
        worktrees: {
          onChanged: () => () => {},
          onBaseStatus: () => () => {},
          onRemoteBranchConflict: () => () => {}
        },
        ui: {
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
          onActivateWorktree: () => () => {},
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
          onPaneFocus: () => () => {},
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
          getTerminalDrivers: () => Promise.resolve([]),
          getBrowserDrivers: () => Promise.resolve([]),
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {},
          onBrowserDriverChanged: () => () => {},
          ...args.runtime
        },
        ssh: {
          listTargets: () => Promise.resolve([]),
          listPortForwards: () => Promise.resolve([]),
          listDetectedPorts: () => Promise.resolve([]),
          getState: () => Promise.resolve(null),
          onStateChanged: () => () => {},
          onCredentialRequest: () => () => {},
          onCredentialResolved: () => () => {},
          onPortForwardsChanged: () => () => {},
          onDetectedPortsChanged: () => () => {}
        },
        agentStatus: {
          onSet: args.onSet,
          getSnapshot: args.getSnapshot ?? vi.fn(() => Promise.resolve([])),
          drop: args.drop ?? vi.fn()
        },
        remoteWorkspace: args.remoteWorkspace
      }
    }
  }

  function stubReactSyncEffect(): void {
    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return {
        ...actual,
        useEffect: (effect: () => void | (() => void)) => {
          effect()
        }
      }
    })
  }

  function stubAuxiliaryModules(): void {
    vi.doMock('@/lib/ui-zoom', () => ({ applyUIZoom: vi.fn() }))
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
    vi.doMock('@/lib/zoom-events', () => ({ dispatchZoomLevelChanged: vi.fn() }))
  }

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('caps pending mobile state events while startup hydration is unresolved', async () => {
    const setFitOverride = vi.fn()
    const hydrateOverrides = vi.fn()
    const setDriverForPty = vi.fn()
    const hydrateDrivers = vi.fn()
    const setDriverForBrowserPage = vi.fn()
    const hydrateBrowserDrivers = vi.fn()
    const listeners: { fit?: MobileFitListener } = {}
    let resolveFitOverrides: (value: []) => void = () => {}
    let resolveDrivers: (value: []) => void = () => {}
    let resolveBrowserDrivers: (value: []) => void = () => {}

    vi.doMock('@/lib/pane-manager/mobile-fit-overrides', () => ({
      setFitOverride,
      hydrateOverrides
    }))
    vi.doMock('@/lib/pane-manager/mobile-driver-state', () => ({
      setDriverForPty,
      hydrateDrivers
    }))
    vi.doMock('@/lib/pane-manager/browser-mobile-driver-state', () => ({
      setDriverForBrowserPage,
      hydrateBrowserDrivers
    }))
    stubReactSyncEffect()
    stubAuxiliaryModules()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => buildStoreState({})
      }
    }))
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: () => () => {},
        runtime: {
          getTerminalFitOverrides: () =>
            new Promise<[]>((resolve) => {
              resolveFitOverrides = resolve
            }),
          getTerminalDrivers: () =>
            new Promise<[]>((resolve) => {
              resolveDrivers = resolve
            }),
          getBrowserDrivers: () =>
            new Promise<[]>((resolve) => {
              resolveBrowserDrivers = resolve
            }),
          onTerminalFitOverrideChanged: (listener: MobileFitListener) => {
            listeners.fit = listener
            return () => {}
          }
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    const emitFit = listeners.fit
    if (!emitFit) {
      throw new Error('Expected fit listener to be registered')
    }
    for (let index = 0; index < 350; index += 1) {
      emitFit({
        ptyId: `pty-${index}`,
        mode: 'mobile-fit',
        cols: 80,
        rows: 24
      })
    }
    expect(setFitOverride).not.toHaveBeenCalled()

    resolveFitOverrides([])
    resolveDrivers([])
    resolveBrowserDrivers([])
    await Promise.resolve()
    await Promise.resolve()

    expect(hydrateOverrides).toHaveBeenCalledWith([])
    expect(hydrateDrivers).toHaveBeenCalledWith([])
    expect(hydrateBrowserDrivers).toHaveBeenCalledWith([])
    expect(setFitOverride).toHaveBeenCalledTimes(300)
    expect(setFitOverride).toHaveBeenNthCalledWith(1, 'pty-50', 'mobile-fit', 80, 24)
    expect(setFitOverride).toHaveBeenLastCalledWith('pty-349', 'mobile-fit', 80, 24)
  })

  it('clears pending mobile state events and ignores late hydration after cleanup', async () => {
    const setFitOverride = vi.fn()
    const hydrateOverrides = vi.fn()
    const setDriverForPty = vi.fn()
    const hydrateDrivers = vi.fn()
    const setDriverForBrowserPage = vi.fn()
    const hydrateBrowserDrivers = vi.fn()
    const unsubscribeFit = vi.fn()
    const unsubscribeDriver = vi.fn()
    const unsubscribeBrowserDriver = vi.fn()
    const refs: {
      cleanup?: () => void
      fit?: MobileFitListener
      driver?: MobileDriverListener
      browserDriver?: MobileBrowserDriverListener
    } = {}
    let resolveFitOverrides: (value: []) => void = () => {}
    let resolveDrivers: (value: []) => void = () => {}
    let resolveBrowserDrivers: (value: []) => void = () => {}

    vi.doMock('@/lib/pane-manager/mobile-fit-overrides', () => ({
      setFitOverride,
      hydrateOverrides
    }))
    vi.doMock('@/lib/pane-manager/mobile-driver-state', () => ({
      setDriverForPty,
      hydrateDrivers
    }))
    vi.doMock('@/lib/pane-manager/browser-mobile-driver-state', () => ({
      setDriverForBrowserPage,
      hydrateBrowserDrivers
    }))
    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return {
        ...actual,
        useEffect: (effect: () => void | (() => void)) => {
          const result = effect()
          if (typeof result === 'function') {
            refs.cleanup = result
          }
        }
      }
    })
    stubAuxiliaryModules()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => buildStoreState({})
      }
    }))
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: () => () => {},
        runtime: {
          getTerminalFitOverrides: () =>
            new Promise<[]>((resolve) => {
              resolveFitOverrides = resolve
            }),
          getTerminalDrivers: () =>
            new Promise<[]>((resolve) => {
              resolveDrivers = resolve
            }),
          getBrowserDrivers: () =>
            new Promise<[]>((resolve) => {
              resolveBrowserDrivers = resolve
            }),
          onTerminalFitOverrideChanged: (listener: MobileFitListener) => {
            refs.fit = listener
            return unsubscribeFit
          },
          onTerminalDriverChanged: (listener: MobileDriverListener) => {
            refs.driver = listener
            return unsubscribeDriver
          },
          onBrowserDriverChanged: (listener: MobileBrowserDriverListener) => {
            refs.browserDriver = listener
            return unsubscribeBrowserDriver
          }
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    if (!refs.fit || !refs.driver || !refs.browserDriver || !refs.cleanup) {
      throw new Error('Expected mobile listeners and cleanup to be registered')
    }

    refs.fit({
      ptyId: 'pty-1',
      mode: 'mobile-fit',
      cols: 80,
      rows: 24
    })
    refs.driver({
      ptyId: 'pty-1',
      driver: { kind: 'mobile', clientId: 'phone' }
    })
    refs.browserDriver({
      browserPageId: 'page-1',
      driver: { kind: 'mobile', clientId: 'phone' }
    })

    refs.cleanup()
    resolveFitOverrides([])
    resolveDrivers([])
    resolveBrowserDrivers([])
    await Promise.resolve()
    await Promise.resolve()

    expect(unsubscribeFit).toHaveBeenCalledTimes(1)
    expect(unsubscribeDriver).toHaveBeenCalledTimes(1)
    expect(unsubscribeBrowserDriver).toHaveBeenCalledTimes(1)
    expect(hydrateOverrides).not.toHaveBeenCalled()
    expect(hydrateDrivers).not.toHaveBeenCalled()
    expect(hydrateBrowserDrivers).not.toHaveBeenCalled()
    expect(setFitOverride).not.toHaveBeenCalled()
    expect(setDriverForPty).not.toHaveBeenCalled()
    expect(setDriverForBrowserPage).not.toHaveBeenCalled()
  })

  it('ignores early push events but applies the main-process snapshot after readiness', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() =>
      Promise.resolve([
        {
          paneKey: FUTURE_PANE_KEY,
          state: 'working' as const,
          prompt: 'p',
          agentType: 'claude',
          receivedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000
        }
      ])
    )
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      tabsByWorktree: {},
      workspaceSessionReady: false
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn((listener: StoreSubscribeListener) => {
          subscribeListenerRef.current = listener
          return () => {
            subscribeListenerRef.current = null
          }
        }),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    // Fire an event for an unknown paneKey while not ready — must NOT call setAgentStatus.
    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'p',
      agentType: 'claude',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })
    expect(setAgentStatus).not.toHaveBeenCalled()
    expect(getSnapshot).not.toHaveBeenCalled()

    storeState.workspaceSessionReady = true
    storeState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' }]
    }
    storeState.terminalLayoutsByTabId = {
      'tab-future': {
        root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
        activeLeafId: FUTURE_LEAF_ID,
        expandedLeafId: null
      }
    }
    if (typeof subscribeListenerRef.current !== 'function') {
      throw new Error('Expected useAppStore.subscribe listener to be registered')
    }
    subscribeListenerRef.current(storeState)
    await Promise.resolve()

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({ state: 'working', prompt: 'p', agentType: 'claude' }),
      'Future Tab',
      { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 }
    )
  })

  it('applies ready push events for an unmounted inactive terminal tab', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Inactive Tab' }]
      },
      terminalLayoutsByTabId: {}
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'done',
      prompt: 'inactive prompt',
      agentType: 'codex',
      lastAssistantMessage: 'inactive completion',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'done',
        prompt: 'inactive prompt',
        agentType: 'codex',
        lastAssistantMessage: 'inactive completion'
      }),
      'Inactive Tab',
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 }
    )
  })

  it('does not retain a Cursor spinner terminal title when the hook reports done', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-future',
            ptyId: 'pty-1',
            worktreeId: 'wt-1',
            title: '\u2839 Cursor Agent'
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null,
          titlesByLeafId: { [FUTURE_LEAF_ID]: '\u2839 Cursor Agent' }
        }
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'done',
      prompt: 'cursor prompt',
      agentType: 'cursor',
      lastAssistantMessage: 'cursor completion',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'done',
        prompt: 'cursor prompt',
        agentType: 'cursor',
        lastAssistantMessage: 'cursor completion'
      }),
      'Cursor ready',
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 }
    )
  })

  it('drops nested child done push events when the parent pane agent is still active', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: true, agentTaskComplete: true } },
      agentStatusByPaneKey: {
        [FUTURE_PANE_KEY]: {
          state: 'working',
          prompt: 'parent codex',
          agentType: 'codex',
          updatedAt: 1_700_000_000_000,
          stateStartedAt: 1_700_000_000_000,
          paneKey: FUTURE_PANE_KEY,
          stateHistory: []
        }
      },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Codex' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [FUTURE_LEAF_ID]: 'pty-1' }
        }
      },
      ptyIdsByTabId: { 'tab-future': ['pty-1'] }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'done',
      prompt: 'nested claude',
      agentType: 'claude',
      lastAssistantMessage: 'child finished',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_700_000_000_200
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('keeps OpenClaude hook status distinct when it arrives through Claude-compatible hooks', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Terminal 2' }]
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-future',
            entityId: 'tab-future',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'terminal',
            label: 'OpenClaude',
            customLabel: null,
            sortOrder: 0,
            createdAt: 1_700_000_000_000
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'OpenClaude prompt',
      agentType: 'claude',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'working',
        prompt: 'OpenClaude prompt',
        agentType: 'openclaude'
      }),
      'Terminal 2',
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 }
    )
  })

  it('applies ready push events for inactive terminal tabs with empty layout snapshots', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Inactive Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'done',
      prompt: 'inactive prompt',
      agentType: 'codex',
      lastAssistantMessage: 'inactive completion',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'done',
        prompt: 'inactive prompt',
        agentType: 'codex',
        lastAssistantMessage: 'inactive completion'
      }),
      'Inactive Tab',
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 }
    )
  })

  it('buffers ready push events until a mounted tab contains the pane leaf', async () => {
    const setAgentStatus = vi.fn()
    const track = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: STALE_LEAF_ID },
          activeLeafId: STALE_LEAF_ID,
          expandedLeafId: null
        }
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn((listener: StoreSubscribeListener) => {
          subscribeListenerRef.current = listener
          return () => {
            subscribeListenerRef.current = null
          }
        }),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.doMock('@/lib/telemetry', () => ({ track }))
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'queued prompt',
      agentType: 'codex',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })
    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'done',
      prompt: 'queued prompt',
      agentType: 'codex',
      lastAssistantMessage: 'queued completion',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledWith('agent_hook_unattributed', {
      reason: 'unknown_tab_id'
    })

    storeState.terminalLayoutsByTabId = {
      'tab-future': {
        root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
        activeLeafId: FUTURE_LEAF_ID,
        expandedLeafId: null
      }
    }
    if (typeof subscribeListenerRef.current !== 'function') {
      throw new Error('Expected useAppStore.subscribe listener to be registered')
    }
    subscribeListenerRef.current(storeState)

    expect(setAgentStatus).toHaveBeenCalledTimes(2)
    expect(setAgentStatus).toHaveBeenNthCalledWith(
      1,
      FUTURE_PANE_KEY,
      expect.objectContaining({ state: 'working', prompt: 'queued prompt', agentType: 'codex' }),
      'Future Tab',
      { updatedAt: 1_700_000_000_100, stateStartedAt: 1_699_999_999_100 }
    )
    expect(setAgentStatus).toHaveBeenNthCalledWith(
      2,
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'done',
        prompt: 'queued prompt',
        agentType: 'codex',
        lastAssistantMessage: 'queued completion'
      }),
      'Future Tab',
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 }
    )
  })

  it('applies remote status snapshots while repo ownership is still hydrating', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() =>
      Promise.resolve([
        {
          paneKey: FUTURE_PANE_KEY,
          state: 'working' as const,
          prompt: 'remote p',
          agentType: 'codex',
          worktreeId: 'wt-1',
          connectionId: 'ssh-1',
          receivedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000
        }
      ])
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'SSH Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      },
      repos: [],
      worktreesByRepo: {}
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({ state: 'working', prompt: 'remote p', agentType: 'codex' }),
      'SSH Tab',
      { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 }
    )
  })

  it('still rejects remote status events once the pane resolves to a local repo', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Local Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      },
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()
    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'remote p',
      agentType: 'codex',
      worktreeId: 'wt-1',
      connectionId: 'ssh-1',
      receivedAt: 1_700_000_000_000,
      stateStartedAt: 1_699_999_999_000
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('tracks ready push events whose paneKey does not resolve to a renderer tab', async () => {
    const setAgentStatus = vi.fn()
    const track = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-known', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Known' }]
      },
      workspaceSessionReady: true
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.doMock('@/lib/telemetry', () => ({ track }))
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: 'tab-missing:0',
      state: 'working',
      prompt: 'p',
      agentType: 'claude',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledWith('agent_hook_unattributed', {
      reason: 'unknown_tab_id'
    })
  })

  it('pulls the snapshot once workspace session is ready even before settings load', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() => Promise.resolve([]))
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      tabsByWorktree: {},
      workspaceSessionReady: true,
      settings: null
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn((listener: StoreSubscribeListener) => {
          subscribeListenerRef.current = listener
          return () => {
            subscribeListenerRef.current = null
          }
        }),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()
    expect(getSnapshot).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('waits for the remote workspace client id before dropping self notifications', async () => {
    const hydrateWorkspaceSession = vi.fn()
    const hydrateTabsSession = vi.fn()
    const hydrateEditorSession = vi.fn()
    const hydrateBrowserSession = vi.fn()
    let resolveClientId!: (id: string) => void
    const clientId = new Promise<string>((resolve) => {
      resolveClientId = resolve
    })
    const onChangedListenerRef: {
      current:
        | ((event: {
            targetId: string
            sourceClientId?: string
            snapshot: Record<string, unknown>
          }) => void)
        | null
    } = { current: null }
    const storeState: StoreLike = buildStoreState({
      workspaceSessionReady: true,
      repos: [{ id: 'repo-1', connectionId: 'conn-1' }],
      worktreesByRepo: { 'repo-1': [{ id: 'repo-1::/repo', repoId: 'repo-1' }] },
      hydrateWorkspaceSession,
      hydrateTabsSession,
      hydrateEditorSession,
      hydrateBrowserSession,
      markRemoteWorkspaceHydrated: vi.fn(),
      setRemoteWorkspaceSyncStatus: vi.fn(),
      reconnectPersistedTerminals: vi.fn(() => Promise.resolve())
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: () => () => {},
        remoteWorkspace: {
          clientId: () => clientId,
          onChanged: (cb: typeof onChangedListenerRef.current) => {
            onChangedListenerRef.current = cb
            return () => {}
          }
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    onChangedListenerRef.current?.({
      targetId: 'conn-1',
      sourceClientId: 'client-self',
      snapshot: {
        revision: 1,
        updatedAt: Date.now(),
        session: {
          activeWorktreePath: '/repo',
          activeTabId: 'tab-1',
          tabsByWorktreePath: {
            '/repo': [
              {
                id: 'tab-1',
                ptyId: null,
                worktreePath: '/repo',
                title: 'Remote',
                customTitle: null,
                color: null,
                sortOrder: 1,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: {}
        }
      }
    })
    await Promise.resolve()
    expect(hydrateWorkspaceSession).not.toHaveBeenCalled()

    resolveClientId('client-self')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(hydrateWorkspaceSession).not.toHaveBeenCalled()
    expect(hydrateTabsSession).not.toHaveBeenCalled()
    expect(hydrateEditorSession).not.toHaveBeenCalled()
    expect(hydrateBrowserSession).not.toHaveBeenCalled()
  })

  it('silently discards snapshot entries whose tabs are still unknown', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() =>
      Promise.resolve([
        {
          paneKey: ORPHAN_PANE_KEY,
          state: 'done' as const,
          prompt: 'p',
          agentType: 'claude',
          receivedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000
        }
      ])
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-other', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Other' }]
      },
      terminalLayoutsByTabId: {
        'tab-orphan': {
          root: { type: 'leaf', leafId: ORPHAN_LEAF_ID },
          activeLeafId: ORPHAN_LEAF_ID,
          expandedLeafId: null
        }
      },
      workspaceSessionReady: true
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()
    await Promise.resolve()

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('silently discards valid paneKeys whose leaf is not in the current layout', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() =>
      Promise.resolve([
        {
          paneKey: STALE_PANE_KEY,
          state: 'done' as const,
          prompt: 'p',
          agentType: 'claude',
          receivedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000
        }
      ])
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      },
      workspaceSessionReady: true
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()
    await Promise.resolve()

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('forwards events whose connectionId matches the live repo connection', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      repos: [{ id: 'repo-1', connectionId: 'conn-1' }],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
      },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Terminal 1' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: TAB_1_LEAF_ID },
          activeLeafId: TAB_1_LEAF_ID,
          expandedLeafId: null
        }
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => storeState }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    onSetListenerRef.current?.({
      paneKey: TAB_1_PANE_KEY,
      connectionId: 'conn-1',
      state: 'working',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).toHaveBeenCalledWith(
      TAB_1_PANE_KEY,
      expect.objectContaining({ state: 'working' }),
      'Terminal 1',
      { updatedAt: 1_700_000_000_100, stateStartedAt: 1_699_999_999_100 }
    )
  })

  it('drops events whose connectionId no longer matches the live local repo', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
      },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Terminal 1' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: TAB_1_LEAF_ID },
          activeLeafId: TAB_1_LEAF_ID,
          expandedLeafId: null
        }
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => storeState }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    onSetListenerRef.current?.({
      paneKey: TAB_1_PANE_KEY,
      connectionId: 'conn-stale',
      state: 'working',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('drops remote-stamped events when the owning worktree is no longer in worktreesByRepo', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      repos: [{ id: 'repo-1', connectionId: 'conn-1' }],
      worktreesByRepo: { 'repo-1': [] },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Terminal 1' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: TAB_1_LEAF_ID },
          activeLeafId: TAB_1_LEAF_ID,
          expandedLeafId: null
        }
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => storeState }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    onSetListenerRef.current?.({
      paneKey: TAB_1_PANE_KEY,
      connectionId: 'conn-other',
      state: 'working',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('accepts events without a stamped connectionId for preload compatibility', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      repos: [{ id: 'repo-1', connectionId: 'conn-1' }],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
      },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Terminal 1' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: TAB_1_LEAF_ID },
          activeLeafId: TAB_1_LEAF_ID,
          expandedLeafId: null
        }
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => storeState }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    onSetListenerRef.current?.({
      paneKey: TAB_1_PANE_KEY,
      state: 'working',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
  })
})
