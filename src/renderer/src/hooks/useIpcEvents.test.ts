/* eslint-disable max-lines -- Why: this test file keeps the hook wiring mocks close to the assertions so IPC event behavior stays understandable and maintainable. */
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildRuntimeClientEventEnvironmentKey,
  buildNewWorkspaceShortcutModalData,
  getNewlyConnectedRuntimeEnvironmentIds,
  getRuntimeProjectRefreshEnvironmentIds,
  openNewWorkspaceFromShortcut,
  resolveBrowserSessionTabTarget,
  resolveZoomTarget
} from './useIpcEvents'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../shared/types'
import { makePaneKey } from '../../../shared/stable-pane-id'

const { closeTerminalTabMock } = vi.hoisted(() => ({
  closeTerminalTabMock: vi.fn()
}))

vi.mock('@/components/terminal/terminal-tab-actions', () => ({
  closeTerminalTab: closeTerminalTabMock
}))

const FUTURE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const STALE_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const ORPHAN_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const TAB_1_LEAF_ID = '44444444-4444-4444-8444-444444444444'
const FUTURE_PANE_KEY = makePaneKey('tab-future', FUTURE_LEAF_ID)
const STALE_PANE_KEY = makePaneKey('tab-future', STALE_LEAF_ID)
const ORPHAN_PANE_KEY = makePaneKey('tab-orphan', ORPHAN_LEAF_ID)
const TAB_1_PANE_KEY = makePaneKey('tab-1', TAB_1_LEAF_ID)

describe('buildRuntimeClientEventEnvironmentKey', () => {
  it('treats runtime environment ids as a stable set', () => {
    expect(buildRuntimeClientEventEnvironmentKey(['env-b', 'env-a', 'env-b'])).toBe(
      buildRuntimeClientEventEnvironmentKey(['env-a', 'env-b'])
    )
  })
})

describe('getNewlyConnectedRuntimeEnvironmentIds', () => {
  it('returns only environments that became connected', () => {
    expect(getNewlyConnectedRuntimeEnvironmentIds(['env-a'], ['env-a', 'env-b'])).toEqual(['env-b'])
  })

  it('ignores environments that disconnected or stayed connected', () => {
    expect(getNewlyConnectedRuntimeEnvironmentIds(['env-a', 'env-b'], ['env-a'])).toEqual([])
  })

  it('treats every environment as new when none were connected before', () => {
    expect(getNewlyConnectedRuntimeEnvironmentIds([], ['env-a', 'env-a', 'env-b'])).toEqual([
      'env-a',
      'env-b'
    ])
  })
})

describe('getRuntimeProjectRefreshEnvironmentIds', () => {
  it('refreshes when an already-desired runtime becomes reachable', () => {
    expect(
      getRuntimeProjectRefreshEnvironmentIds({
        previousDesired: ['env-a'],
        nextDesired: ['env-a'],
        previousReachable: [],
        nextReachable: ['env-a']
      })
    ).toEqual(['env-a'])
  })

  it('deduplicates runtimes that are both newly desired and newly reachable', () => {
    expect(
      getRuntimeProjectRefreshEnvironmentIds({
        previousDesired: [],
        nextDesired: ['env-a'],
        previousReachable: [],
        nextReachable: ['env-a']
      })
    ).toEqual(['env-a'])
  })
})

function expectWorktreeRouting(worktreeId: string): unknown {
  return expect.objectContaining({ worktreeId })
}

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
  it('routes to terminal zoom when terminal input is focused', () => {
    expect(
      resolveZoomTarget({
        activeView: 'terminal',
        activeTabType: 'terminal',
        activeElement: makeTarget({ hasXtermClass: true })
      })
    ).toBe('terminal')
  })

  it('routes to ui zoom for an active terminal tab after terminal focus is released', () => {
    expect(
      resolveZoomTarget({
        activeView: 'terminal',
        activeTabType: 'terminal',
        activeElement: makeTarget({})
      })
    ).toBe('ui')
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

  it('routes to ui zoom for active browser tabs before stale DOM focus', () => {
    expect(
      resolveZoomTarget({
        activeView: 'terminal',
        activeTabType: 'browser',
        activeElement: makeTarget({ editorClosest: true, hasXtermClass: true })
      })
    ).toBe('ui')
  })

  it('routes to ui zoom for browser tabs without an active browser page', () => {
    expect(
      resolveZoomTarget({
        activeView: 'terminal',
        activeTabType: 'browser',
        activeElement: makeTarget({})
      })
    ).toBe('ui')
  })
})

describe('useIpcEvents zoom routing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('applies app zoom for an active browser tab', async () => {
    const terminalZoomListenerRef: {
      current: ((direction: 'in' | 'out' | 'reset') => void) | null
    } = { current: null }
    const setUI = vi.fn()

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
          activeView: 'terminal',
          activeTabType: 'browser',
          activeWorktreeId: 'wt-1',
          activeBrowserTabId: 'workspace-1',
          activeBrowserTabIdByWorktree: { 'wt-1': 'workspace-1' },
          browserTabsByWorktree: {
            'wt-1': [
              {
                id: 'workspace-1',
                activePageId: 'page-1',
                pageIds: ['page-1']
              }
            ]
          },
          browserPagesByWorkspace: {
            'workspace-1': [{ id: 'page-1', worktreeId: 'wt-1' }]
          },
          editorFontZoomLevel: 0,
          setEditorFontZoomLevel: vi.fn(),
          settings: { terminalFontSize: 13 },
          setUpdateStatus: vi.fn(),
          fetchRepos: vi.fn(),
          fetchWorktrees: vi.fn(),
          setActiveView: vi.fn(),
          activeModal: null,
          closeModal: vi.fn(),
          openModal: vi.fn(),
          setActiveRepo: vi.fn(),
          setActiveWorktree: vi.fn(),
          revealWorktreeInSidebar: vi.fn(),
          setIsFullScreen: vi.fn(),
          setRateLimitsFromPush: vi.fn()
        })
      }
    }))
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
      zoomLevelToPercent: vi.fn(() => 120),
      ZOOM_STEP: 0.5,
      ZOOM_MIN: -3,
      ZOOM_MAX: 3
    }))
    vi.doMock('@/lib/zoom-events', () => ({ dispatchZoomLevelChanged: vi.fn() }))

    const makeEvents = (target: Record<string, unknown> = {}): Record<string, unknown> =>
      new Proxy(target, {
        get: (namespace, prop) => {
          if (prop in namespace) {
            return Reflect.get(namespace, prop)
          }
          return () => () => {}
        }
      })
    vi.stubGlobal('document', {
      activeElement: makeTarget({ editorClosest: true })
    })

    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      api: {
        repos: makeEvents(),
        worktrees: makeEvents(),
        keybindings: makeEvents(),
        settings: makeEvents(),
        updater: {
          getStatus: () => Promise.resolve({ state: 'idle' }),
          onStatus: () => () => {},
          onClearDismissal: () => () => {}
        },
        browser: makeEvents(),
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
          onCredentialResolved: () => () => {},
          onPortForwardsChanged: () => () => {},
          onDetectedPortsChanged: () => () => {}
        },
        runtime: {
          getTerminalFitOverrides: () => Promise.resolve([]),
          getTerminalDrivers: () => Promise.resolve([]),
          getBrowserDrivers: () => Promise.resolve([]),
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {},
          onBrowserDriverChanged: () => () => {}
        },
        agentStatus: { onSet: () => () => {} },
        ui: makeEvents({
          onTerminalZoom: (listener: (direction: 'in' | 'out' | 'reset') => void) => {
            terminalZoomListenerRef.current = listener
            return () => {}
          },
          getZoomLevel: vi.fn(() => 0),
          set: setUI
        })
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    const { applyUIZoom } = await import('@/lib/ui-zoom')

    useIpcEvents()
    expect(terminalZoomListenerRef.current).toBeTypeOf('function')
    const listener = terminalZoomListenerRef.current
    if (!listener) {
      throw new Error('Expected terminal zoom listener to be registered')
    }
    listener('in')

    expect(applyUIZoom).toHaveBeenCalledWith(0.5)
    expect(setUI).toHaveBeenCalledWith({ uiZoomLevel: 0.5 })
  })

  it('applies app zoom for an active terminal tab after terminal focus is released', async () => {
    const terminalZoomListenerRef: {
      current: ((direction: 'in' | 'out' | 'reset') => void) | null
    } = { current: null }
    const setUI = vi.fn()

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
          activeView: 'terminal',
          activeTabType: 'terminal',
          activeWorktreeId: 'wt-1',
          activeBrowserTabId: null,
          activeBrowserTabIdByWorktree: {},
          browserTabsByWorktree: {},
          browserPagesByWorkspace: {},
          editorFontZoomLevel: 0,
          setEditorFontZoomLevel: vi.fn(),
          settings: { terminalFontSize: 13 },
          setUpdateStatus: vi.fn(),
          fetchRepos: vi.fn(),
          fetchWorktrees: vi.fn(),
          setActiveView: vi.fn(),
          activeModal: null,
          closeModal: vi.fn(),
          openModal: vi.fn(),
          setActiveRepo: vi.fn(),
          setActiveWorktree: vi.fn(),
          revealWorktreeInSidebar: vi.fn(),
          setIsFullScreen: vi.fn(),
          setRateLimitsFromPush: vi.fn()
        })
      }
    }))
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
      zoomLevelToPercent: vi.fn(() => 120),
      ZOOM_STEP: 0.5,
      ZOOM_MIN: -3,
      ZOOM_MAX: 3
    }))
    vi.doMock('@/lib/zoom-events', () => ({ dispatchZoomLevelChanged: vi.fn() }))

    const makeEvents = (target: Record<string, unknown> = {}): Record<string, unknown> =>
      new Proxy(target, {
        get: (namespace, prop) => {
          if (prop in namespace) {
            return Reflect.get(namespace, prop)
          }
          return () => () => {}
        }
      })
    vi.stubGlobal('document', {
      activeElement: makeTarget({})
    })

    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      api: {
        repos: makeEvents(),
        worktrees: makeEvents(),
        keybindings: makeEvents(),
        settings: makeEvents(),
        updater: {
          getStatus: () => Promise.resolve({ state: 'idle' }),
          onStatus: () => () => {},
          onClearDismissal: () => () => {}
        },
        browser: makeEvents(),
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
          onCredentialResolved: () => () => {},
          onPortForwardsChanged: () => () => {},
          onDetectedPortsChanged: () => () => {}
        },
        runtime: {
          getTerminalFitOverrides: () => Promise.resolve([]),
          getTerminalDrivers: () => Promise.resolve([]),
          getBrowserDrivers: () => Promise.resolve([]),
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {},
          onBrowserDriverChanged: () => () => {}
        },
        agentStatus: { onSet: () => () => {} },
        ui: makeEvents({
          onTerminalZoom: (listener: (direction: 'in' | 'out' | 'reset') => void) => {
            terminalZoomListenerRef.current = listener
            return () => {}
          },
          getZoomLevel: vi.fn(() => 0),
          set: setUI
        })
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    const { applyUIZoom } = await import('@/lib/ui-zoom')
    const { dispatchZoomLevelChanged } = await import('@/lib/zoom-events')

    useIpcEvents()
    const listener = terminalZoomListenerRef.current
    if (!listener) {
      throw new Error('Expected terminal zoom listener to be registered')
    }
    listener('in')

    expect(applyUIZoom).toHaveBeenCalledWith(0.5)
    expect(setUI).toHaveBeenCalledWith({ uiZoomLevel: 0.5 })
    expect(dispatchZoomLevelChanged).toHaveBeenCalledWith('ui', 120)
  })
})

describe('useIpcEvents rate-limit hydration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('does not miss startup usage updates that land between get and subscription', async () => {
    const setRateLimitsFromPush = vi.fn()
    const staleState = {
      claude: null,
      codex: null,
      gemini: null,
      opencodeGo: null,
      kimi: null,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
    const freshState = {
      ...staleState,
      claude: {
        provider: 'claude',
        session: {
          usedPercent: 12,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        weekly: null,
        updatedAt: 1,
        error: null,
        status: 'ok'
      },
      codex: {
        provider: 'codex',
        session: {
          usedPercent: 24,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        weekly: null,
        updatedAt: 1,
        error: null,
        status: 'ok'
      }
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
          activeTabType: 'terminal',
          editorFontZoomLevel: 0,
          setEditorFontZoomLevel: vi.fn(),
          settings: { terminalFontSize: 13 },
          setRateLimitsFromPush,
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
          updateTabTitle: vi.fn(),
          runtimePaneTitlesByTabId: {},
          terminalLayoutsByTabId: {},
          agentStatusByPaneKey: {},
          recentlyClosedAgentStatusTabIds: {},
          repos: [],
          worktreesByRepo: {},
          tabsByWorktree: {},
          unifiedTabsByWorktree: {},
          workspaceSessionReady: false
        })
      }
    }))
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

    const makeEvents = (target: Record<string, unknown> = {}): Record<string, unknown> =>
      new Proxy(target, {
        get: (namespace, prop) => {
          if (prop in namespace) {
            return Reflect.get(namespace, prop)
          }
          return () => () => {}
        }
      })

    let rateLimitUpdateListener: ((state: unknown) => void) | null = null
    const getRateLimits = vi.fn(() => {
      if (rateLimitUpdateListener) {
        rateLimitUpdateListener(freshState)
      }
      return Promise.resolve(staleState)
    })

    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      api: {
        repos: makeEvents(),
        worktrees: makeEvents(),
        keybindings: makeEvents(),
        settings: makeEvents(),
        updater: {
          getStatus: () => Promise.resolve({ state: 'idle' }),
          onStatus: () => () => {},
          onClearDismissal: () => () => {}
        },
        browser: makeEvents(),
        rateLimits: {
          get: getRateLimits,
          onUpdate: (listener: (state: unknown) => void) => {
            rateLimitUpdateListener = listener
            return () => {}
          }
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
        runtime: {
          getTerminalFitOverrides: () => Promise.resolve([]),
          getTerminalDrivers: () => Promise.resolve([]),
          getBrowserDrivers: () => Promise.resolve([]),
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {},
          onBrowserDriverChanged: () => () => {}
        },
        agentStatus: { onSet: () => () => {} },
        ui: makeEvents({
          getZoomLevel: vi.fn(() => 0)
        })
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    expect(setRateLimitsFromPush).toHaveBeenLastCalledWith(freshState)
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
    expect(data.prefilledName).toBe('eng-123-fix-linear-context-handoff')
    expect(data.linkedWorkItem).toMatchObject({
      type: 'issue',
      number: 0,
      title: 'Fix Linear context handoff',
      url: 'https://linear.app/acme/issue/ENG-123/fix-linear-context-handoff',
      linearIdentifier: 'ENG-123'
    })
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

describe('openNewWorkspaceFromShortcut', () => {
  it('opens the composer even when no project has been added yet', () => {
    const openModal = vi.fn()

    openNewWorkspaceFromShortcut({
      activeModal: 'none',
      activeView: 'terminal',
      taskPageData: {},
      openModal
    } as never)

    expect(openModal).toHaveBeenCalledWith('new-workspace-composer', {
      telemetrySource: 'shortcut'
    })
  })

  it('does not reopen the composer when it is already active', () => {
    const openModal = vi.fn()

    openNewWorkspaceFromShortcut({
      activeModal: 'new-workspace-composer',
      activeView: 'terminal',
      taskPageData: {},
      openModal
    } as never)

    expect(openModal).not.toHaveBeenCalled()
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

    acquireBrowserAutomationVisibility.mockClear()
    dispatchEvent.mockClear()

    activateViewListenerRef.current?.({ browserPageId: 'page-detached' })

    expect(acquireBrowserAutomationVisibility).toHaveBeenCalledWith('page-detached')
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { worktreeId: 'wt-2' } })
    )
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
    const createWebRuntimeSessionTerminal = vi.fn().mockResolvedValue(false)
    const focusRuntimeTerminalSurface = vi.fn(() => false)
    const focusTerminalTabSurface = vi.fn()
    let floatingPanelFocused = false
    const storeState = {
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
            launchConfig?: SleepingAgentLaunchConfig
            launchAgent?: TuiAgent
            title?: string
            ptyId?: string
            activate?: boolean
            tabId?: string
            leafId?: string
            splitFromLeafId?: string
            splitDirection?: 'horizontal' | 'vertical'
            splitTelemetrySource?:
              | 'contextual_tour'
              | 'keyboard'
              | 'context_menu'
              | 'command'
              | 'unknown'
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
            launchConfig?: SleepingAgentLaunchConfig
            launchAgent?: TuiAgent
            title?: string
            activate?: boolean
          }) => void)
        | null
    } = { current: null }
    const focusTerminalListenerRef: {
      current:
        | ((data: {
            tabId: string
            worktreeId: string
            leafId?: string | null
            ackPaneKeyOnSuccess?: string
            flashFocusedPane?: boolean
            scrollToBottomIfOutputSinceLastView?: boolean
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
      focusTerminalTabSurface
    }))
    vi.doMock('@/runtime/sync-runtime-graph', () => ({
      focusRuntimeTerminalSurface
    }))
    vi.doMock('@/lib/activate-tab-and-focus-pane', () => ({
      activateTabAndFocusPane: vi.fn()
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
          onActivateWorktree: () => () => {},
          onWorktreeHistoryNavigate: () => () => {},
          onCreateTerminal: (
            listener: (data: {
              requestId?: string
              worktreeId: string
              command?: string
              launchConfig?: SleepingAgentLaunchConfig
              launchAgent?: TuiAgent
              title?: string
              ptyId?: string
              activate?: boolean
              tabId?: string
              leafId?: string
              splitFromLeafId?: string
              splitDirection?: 'horizontal' | 'vertical'
              splitTelemetrySource?:
                | 'contextual_tour'
                | 'keyboard'
                | 'context_menu'
                | 'command'
                | 'unknown'
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
              launchConfig?: SleepingAgentLaunchConfig
              launchAgent?: TuiAgent
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
          onFocusTerminal: (
            listener: (data: {
              tabId: string
              worktreeId: string
              leafId?: string | null
              ackPaneKeyOnSuccess?: string
              flashFocusedPane?: boolean
              scrollToBottomIfOutputSinceLastView?: boolean
            }) => void
          ) => {
            focusTerminalListenerRef.current = listener
            return () => {}
          },
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
      // Why: multi-host scopes the new terminal to the worktree's own runtime
      // env (null here -> falls back to the active env inside the helper).
      environmentId: null,
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
    expect(markWorktreeVisited).toHaveBeenCalledWith('wt-2')
    expect(recordWorktreeVisit).toHaveBeenCalledWith('wt-2')
    expect(createTab).toHaveBeenCalledWith('wt-2')
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(setActiveTab).toHaveBeenCalledWith('tab-new')
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-new', undefined)
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
    markWorktreeVisited.mockClear()
    recordWorktreeVisit.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    setTabCustomTitle.mockClear()
    queueTabStartupCommand.mockClear()
    replyTerminalCreate.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    requestTerminalCreateListenerRef.current({
      requestId: 'req-focused',
      worktreeId: 'wt-3',
      title: 'Shell'
    })

    expect(setActiveView).toHaveBeenCalledWith('terminal')
    expect(setActiveWorktree).toHaveBeenCalledWith('wt-3')
    expect(markWorktreeVisited).toHaveBeenCalledWith('wt-3')
    expect(recordWorktreeVisit).toHaveBeenCalledWith('wt-3')
    expect(createTab).toHaveBeenCalledWith('wt-3', undefined, undefined, undefined)
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(setActiveTab).toHaveBeenCalledWith('tab-new')
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-3')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(setTabCustomTitle).toHaveBeenCalledWith('tab-new', 'Shell', {
      recordInteraction: false
    })
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-focused',
      tabId: 'tab-new',
      title: 'Shell'
    })

    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    markWorktreeVisited.mockClear()
    recordWorktreeVisit.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    setTabCustomTitle.mockClear()
    queueTabStartupCommand.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    requestTerminalCreateListenerRef.current({
      requestId: 'req-renderer-backed',
      worktreeId: 'wt-2',
      targetGroupId: 'group-left',
      title: 'Codex',
      command: 'codex',
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'request' }
      },
      launchAgent: 'codex',
      activate: false
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', 'group-left', undefined, {
      activate: false,
      recordInteraction: false
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(markWorktreeVisited).not.toHaveBeenCalled()
    expect(recordWorktreeVisit).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).not.toHaveBeenCalled()
    expect(focusRuntimeTerminalSurface).not.toHaveBeenCalled()
    expect(focusTerminalTabSurface).not.toHaveBeenCalled()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-2' }
      })
    )
    expect(setTabCustomTitle).toHaveBeenCalledWith('tab-new', 'Codex', {
      recordInteraction: false
    })
    expect(queueTabStartupCommand).toHaveBeenCalledWith('tab-new', {
      command: 'codex',
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'request' }
      },
      launchAgent: 'codex'
    })
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-renderer-backed',
      tabId: 'tab-new',
      title: 'Codex'
    })

    if (typeof focusTerminalListenerRef.current !== 'function') {
      throw new Error('Expected focus-terminal listener to be registered')
    }

    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    markWorktreeVisited.mockClear()
    recordWorktreeVisit.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    focusTerminalListenerRef.current({
      worktreeId: 'wt-4',
      tabId: 'tab-focus',
      leafId: 'leaf-focus'
    })

    expect(setActiveView).toHaveBeenCalledWith('terminal')
    expect(setActiveWorktree).toHaveBeenCalledWith('wt-4')
    expect(markWorktreeVisited).toHaveBeenCalledWith('wt-4')
    expect(recordWorktreeVisit).toHaveBeenCalledWith('wt-4')
    expect(setActiveTab).toHaveBeenCalledWith('tab-focus')
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-4')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-focus', 'leaf-focus')
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-focus', 'leaf-focus')

    storeState.isNavigatingHistory = true
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    markWorktreeVisited.mockClear()
    recordWorktreeVisit.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    focusTerminalListenerRef.current({
      worktreeId: 'wt-history',
      tabId: 'tab-history'
    })

    expect(setActiveView).toHaveBeenCalledWith('terminal')
    expect(setActiveWorktree).toHaveBeenCalledWith('wt-history')
    expect(markWorktreeVisited).toHaveBeenCalledWith('wt-history')
    expect(recordWorktreeVisit).not.toHaveBeenCalled()
    expect(setActiveTab).toHaveBeenCalledWith('tab-history')
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-history')
    storeState.isNavigatingHistory = false

    createTab.mockClear()
    registerAgentLaunchConfig.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-bg',
      leafId: '55555555-5555-4555-8555-555555555555',
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'adopted' }
      },
      launchAgent: 'codex'
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-bg',
      activate: true
    })
    expect(registerAgentLaunchConfig).toHaveBeenCalledWith(
      makePaneKey('tab-new', '55555555-5555-4555-8555-555555555555'),
      {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'adopted' }
      },
      {
        agentType: 'codex',
        tabId: 'tab-new',
        leafId: '55555555-5555-4555-8555-555555555555'
      }
    )

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

    const pendingTabId = 'ba416891-cbcb-4778-8d9c-d8907f31a68c'
    const pendingLeafId = 'e4583c63-2d9a-4877-b66f-05c0150f05f9'
    storeState.tabsByWorktree = {
      'wt-2': [{ id: pendingTabId, ptyId: null, title: 'Terminal 3' }]
    }
    storeState.ptyIdsByTabId = { [pendingTabId]: [] }
    storeState.terminalLayoutsByTabId = {
      [pendingTabId]: {
        root: { type: 'leaf', leafId: pendingLeafId },
        activeLeafId: pendingLeafId,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
    }
    createTab.mockClear()
    updateTabPtyId.mockClear()
    setTabLayout.mockClear()
    setActiveTab.mockClear()
    replyTerminalCreate.mockClear()
    createTerminalListenerRef.current({
      requestId: 'req-adopt-pending',
      worktreeId: 'wt-2',
      ptyId: 'serve-cf39bedb-a33a-417c-9ab6-f304dc27a6c0',
      tabId: pendingTabId,
      leafId: pendingLeafId
    })

    expect(createTab).not.toHaveBeenCalled()
    expect(updateTabPtyId).toHaveBeenCalledWith(
      pendingTabId,
      'serve-cf39bedb-a33a-417c-9ab6-f304dc27a6c0'
    )
    expect(setTabLayout).toHaveBeenCalledWith(pendingTabId, {
      root: { type: 'leaf', leafId: pendingLeafId },
      activeLeafId: pendingLeafId,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [pendingLeafId]: 'serve-cf39bedb-a33a-417c-9ab6-f304dc27a6c0'
      }
    })
    expect(setActiveTab).toHaveBeenCalledWith(pendingTabId)
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-adopt-pending',
      tabId: pendingTabId,
      title: 'Terminal 3'
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
      splitDirection: 'vertical',
      splitTelemetrySource: 'contextual_tour'
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
          sourcePtyId: 'pty-bg',
          telemetrySource: 'contextual_tour',
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
    closeTerminalTabMock.mockReset()
  })

  type RequestTabCloseListener = (data: {
    requestId: string
    tabId: string | null
    worktreeId?: string
  }) => void
  type CloseActiveTabListener = () => void
  type CloseTerminalListener = (data: { tabId: string; paneRuntimeId?: number | null }) => void
  type CloseSessionTabListener = (data: { tabId: string; worktreeId: string }) => void

  async function useIpcEventsForCloseRouting({
    closeActiveTabListenerRef,
    closeSessionTabListenerRef,
    closeTerminalListenerRef,
    getState,
    requestTabCloseListenerRef,
    replyTabClose = vi.fn()
  }: {
    closeActiveTabListenerRef?: { current: CloseActiveTabListener | null }
    closeSessionTabListenerRef?: { current: CloseSessionTabListener | null }
    closeTerminalListenerRef?: { current: CloseTerminalListener | null }
    getState: () => Record<string, unknown>
    requestTabCloseListenerRef?: { current: RequestTabCloseListener | null }
    replyTabClose?: ReturnType<typeof vi.fn>
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
          onActivateWorktree: () => () => {},
          onCreateTerminal: () => () => {},
          onRequestTerminalCreate: () => () => {},
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
          onMoveSessionTab: () => () => {},
          onOpenFileFromMobile: () => () => {},
          onOpenDiffFromMobile: () => () => {},
          onCloseTerminal: (listener: CloseTerminalListener) => {
            if (closeTerminalListenerRef) {
              closeTerminalListenerRef.current = listener
            }
            return () => {}
          },
          onSleepWorktree: () => () => {},
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
          onBrowserDriverChanged: () => {}
        },
        agentStatus: { onSet: () => () => {} }
      }
    })

    const { useIpcEvents: registerIpcEvents } = await import('./useIpcEvents')
    registerIpcEvents()
  }

  it('removes the file from openFiles when a companion closes an editor session tab', async () => {
    const closeSessionTabListenerRef: { current: CloseSessionTabListener | null } = {
      current: null
    }
    const closeFile = vi.fn()
    const closeUnifiedTab = vi.fn()

    await useIpcEventsForCloseRouting({
      closeSessionTabListenerRef,
      getState: () => ({
        closeFile,
        closeUnifiedTab,
        browserTabsByWorktree: {},
        unifiedTabsByWorktree: {
          'wt-1': [{ id: 'host-tab-1', entityId: 'file-1', contentType: 'editor', isPinned: false }]
        }
      })
    })

    closeSessionTabListenerRef.current?.({ tabId: 'host-tab-1', worktreeId: 'wt-1' })

    // Why: closeUnifiedTab alone would leave the file in openFiles, which the host
    // republishes — so the editor close must go through closeFile.
    expect(closeFile).toHaveBeenCalledWith('file-1')
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('keeps closeUnifiedTab for a non-editor session tab closed by a companion', async () => {
    const closeSessionTabListenerRef: { current: CloseSessionTabListener | null } = {
      current: null
    }
    const closeFile = vi.fn()
    const closeUnifiedTab = vi.fn()

    await useIpcEventsForCloseRouting({
      closeSessionTabListenerRef,
      getState: () => ({
        closeFile,
        closeUnifiedTab,
        browserTabsByWorktree: {},
        unifiedTabsByWorktree: {
          'wt-1': [
            { id: 'sim-tab-1', entityId: 'sim-1', contentType: 'simulator', isPinned: false }
          ]
        }
      })
    })

    closeSessionTabListenerRef.current?.({ tabId: 'sim-tab-1', worktreeId: 'wt-1' })

    // Why: only editor tabs need the closeFile (openFiles) path; other content types
    // must keep closeUnifiedTab so the editor-only routing stays scoped.
    expect(closeUnifiedTab).toHaveBeenCalledWith('sim-tab-1')
    expect(closeFile).not.toHaveBeenCalled()
  })

  it('delegates terminal close IPC without a pane id to the shared terminal close flow', async () => {
    const closeTerminalListenerRef: { current: CloseTerminalListener | null } = { current: null }

    await useIpcEventsForCloseRouting({
      closeTerminalListenerRef,
      getState: () => ({})
    })

    closeTerminalListenerRef.current?.({ tabId: 'terminal-1' })

    expect(closeTerminalTabMock).toHaveBeenCalledWith('terminal-1')
  })

  it('confirms before closing a pinned active browser tab from the native close event', async () => {
    const closeActiveTabListenerRef: { current: CloseActiveTabListener | null } = { current: null }
    const closeBrowserTab = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()

    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef,
      getState: () => ({
        closeBrowserTab,
        requestPinnedTabCloseConfirm,
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'browser-unified-1',
              entityId: 'workspace-1',
              contentType: 'browser',
              label: 'Docs',
              isPinned: true
            }
          ]
        }
      })
    })

    closeActiveTabListenerRef.current?.()

    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ tabLabel: 'Docs', onConfirm: expect.any(Function) })
    )

    const { onConfirm } = requestPinnedTabCloseConfirm.mock.calls[0][0] as { onConfirm: () => void }
    onConfirm()

    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1')
  })

  it('confirms CLI workspace browser closes and replies after confirmation', async () => {
    const requestTabCloseListenerRef: { current: RequestTabCloseListener | null } = {
      current: null
    }
    const closeBrowserTab = vi.fn()
    const replyTabClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()

    await useIpcEventsForCloseRouting({
      requestTabCloseListenerRef,
      replyTabClose,
      getState: () => ({
        closeBrowserTab,
        requestPinnedTabCloseConfirm,
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'browser-unified-1',
              entityId: 'workspace-1',
              contentType: 'browser',
              label: 'Docs',
              isPinned: true
            }
          ]
        }
      })
    })

    requestTabCloseListenerRef.current?.({ requestId: 'req-pinned', tabId: 'workspace-1' })

    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(replyTabClose).not.toHaveBeenCalledWith({ requestId: 'req-pinned' })
    const request = requestPinnedTabCloseConfirm.mock.calls[0][0] as {
      onConfirm: () => void
      onCancel: () => void
    }

    request.onConfirm()

    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1')
    expect(replyTabClose).toHaveBeenCalledWith({ requestId: 'req-pinned' })
  })

  it('replies with the pinned error when a CLI browser close is canceled', async () => {
    const requestTabCloseListenerRef: { current: RequestTabCloseListener | null } = {
      current: null
    }
    const closeBrowserTab = vi.fn()
    const replyTabClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()

    await useIpcEventsForCloseRouting({
      requestTabCloseListenerRef,
      replyTabClose,
      getState: () => ({
        closeBrowserTab,
        requestPinnedTabCloseConfirm,
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'browser-unified-1',
              entityId: 'workspace-1',
              contentType: 'browser',
              label: 'Docs',
              isPinned: true
            }
          ]
        }
      })
    })

    requestTabCloseListenerRef.current?.({ requestId: 'req-cancel', tabId: 'workspace-1' })
    const request = requestPinnedTabCloseConfirm.mock.calls[0][0] as {
      onCancel: () => void
    }

    request.onCancel()

    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(replyTabClose).toHaveBeenCalledWith({
      requestId: 'req-cancel',
      error: 'Browser tab workspace-1 is pinned'
    })
  })

  it('lets CLI browser closes bypass confirmation when the pinned-tab setting is off', async () => {
    const requestTabCloseListenerRef: { current: RequestTabCloseListener | null } = {
      current: null
    }
    const closeBrowserTab = vi.fn()
    const replyTabClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()

    await useIpcEventsForCloseRouting({
      requestTabCloseListenerRef,
      replyTabClose,
      getState: () => ({
        closeBrowserTab,
        requestPinnedTabCloseConfirm,
        settings: {
          activeRuntimeEnvironmentId: null,
          confirmClosePinnedTab: false,
          terminalFontSize: 13
        },
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'browser-unified-1',
              entityId: 'workspace-1',
              contentType: 'browser',
              label: 'Docs',
              isPinned: true
            }
          ]
        }
      })
    })

    requestTabCloseListenerRef.current?.({ requestId: 'req-off', tabId: 'workspace-1' })

    expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1')
    expect(replyTabClose).toHaveBeenCalledWith({ requestId: 'req-off' })
  })

  it('guards a CLI last-page close for a pinned browser workspace', async () => {
    const requestTabCloseListenerRef: { current: RequestTabCloseListener | null } = {
      current: null
    }
    const closeBrowserTab = vi.fn()
    const closeBrowserPage = vi.fn()
    const replyTabClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()

    await useIpcEventsForCloseRouting({
      requestTabCloseListenerRef,
      replyTabClose,
      getState: () => ({
        closeBrowserTab,
        closeBrowserPage,
        requestPinnedTabCloseConfirm,
        browserPagesByWorkspace: {
          'workspace-1': [{ id: 'page-1', workspaceId: 'workspace-1' }]
        },
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'browser-unified-1',
              entityId: 'workspace-1',
              contentType: 'browser',
              label: 'Docs',
              isPinned: true
            }
          ]
        }
      })
    })

    requestTabCloseListenerRef.current?.({ requestId: 'req-page', tabId: 'page-1' })

    expect(closeBrowserPage).not.toHaveBeenCalled()
    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ tabLabel: 'Docs', onConfirm: expect.any(Function) })
    )
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

  it('refreshes active runtime worktrees from remote client events', async () => {
    const fetchWorktrees = vi.fn()
    const fetchWorktreeLineage = vi.fn()
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
          settings: { activeRuntimeEnvironmentId: 'env-1', terminalFontSize: 13 }
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
        runtimeEnvironments: { subscribe: runtimeSubscribe },
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

    expect(runtimeSubscribe).toHaveBeenCalledWith(
      {
        selector: 'env-1',
        method: 'runtime.clientEvents.subscribe',
        timeoutMs: 15_000
      },
      expect.any(Object)
    )
    if (!runtimeOnResponse) {
      throw new Error('Expected runtime client event callbacks')
    }
    runtimeOnResponse({
      ok: true,
      result: { type: 'worktreesChanged', repoId: 'repo-1' }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1')
    expect(fetchWorktreeLineage).toHaveBeenCalledTimes(1)
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
    terminalHandle?: string
    orchestration?: {
      taskId?: string
      dispatchId?: string
      parentTerminalHandle?: string
      parentPaneKey?: string
      coordinatorHandle?: string
      orchestrationRunId?: string
    }
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
      updateTabTitle: vi.fn(),
      runtimePaneTitlesByTabId: {},
      terminalLayoutsByTabId: {},
      agentStatusByPaneKey: {},
      recentlyClosedAgentStatusTabIds: {},
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
    onClear?: (cb: (data: { paneKey: string }) => void) => () => void
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
          onClear: args.onClear ?? vi.fn(() => () => {}),
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
      { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 },
      expectWorktreeRouting('wt-1'),
      undefined
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
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('drops late push events for a recently closed terminal tab', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      recentlyClosedAgentStatusTabIds: { 'tab-future': true },
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: {},
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
      prompt: 'late completion',
      agentType: 'codex',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('keeps missing-tab runtime attribution for tabs that were never explicitly closed', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      recentlyClosedAgentStatusTabIds: {},
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: { 'wt-1': [] },
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
      state: 'working',
      prompt: 'runtime child',
      agentType: 'codex',
      worktreeId: 'wt-1',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_700_000_000_000,
      orchestration: {
        parentPaneKey: 'parent-tab:11111111-1111-4111-8111-111111111111'
      }
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({ state: 'working', prompt: 'runtime child', agentType: 'codex' }),
      undefined,
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_700_000_000_000 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('clears a worktree-attributed live row when main reports pane teardown', async () => {
    const setAgentStatus = vi.fn()
    const removeAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const onClearListenerRef: { current: ((data: { paneKey: string }) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      removeAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: { 'wt-1': [] },
      terminalLayoutsByTabId: {},
      agentStatusByPaneKey: {
        [FUTURE_PANE_KEY]: {
          state: 'working',
          prompt: 'hidden worker',
          agentType: 'codex',
          updatedAt: 1_700_000_000_200,
          stateStartedAt: 1_700_000_000_000,
          paneKey: FUTURE_PANE_KEY,
          worktreeId: 'wt-1',
          stateHistory: []
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
        },
        onClear: (cb) => {
          onClearListenerRef.current = cb
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
    if (typeof onClearListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onClear listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'hidden worker',
      agentType: 'codex',
      worktreeId: 'wt-1',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_700_000_000_000,
      orchestration: {
        parentPaneKey: 'parent-tab:11111111-1111-4111-8111-111111111111'
      }
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({ state: 'working', prompt: 'hidden worker', agentType: 'codex' }),
      undefined,
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_700_000_000_000 },
      expectWorktreeRouting('wt-1'),
      undefined
    )

    onClearListenerRef.current({ paneKey: FUTURE_PANE_KEY })

    expect(removeAgentStatus).toHaveBeenCalledTimes(1)
    expect(removeAgentStatus).toHaveBeenCalledWith(FUTURE_PANE_KEY)
  })

  it('keeps a completed worktree-attributed row when main reports pane teardown', async () => {
    const removeAgentStatus = vi.fn()
    const onClearListenerRef: { current: ((data: { paneKey: string }) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      removeAgentStatus,
      workspaceSessionReady: true,
      agentStatusByPaneKey: {
        [FUTURE_PANE_KEY]: {
          state: 'done',
          prompt: 'hidden worker',
          agentType: 'codex',
          updatedAt: 1_700_000_000_200,
          stateStartedAt: 1_700_000_000_000,
          paneKey: FUTURE_PANE_KEY,
          worktreeId: 'wt-1',
          stateHistory: []
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
        onSet: () => () => {},
        onClear: (cb) => {
          onClearListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onClearListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onClear listener to be registered')
    }

    onClearListenerRef.current({ paneKey: FUTURE_PANE_KEY })

    expect(removeAgentStatus).not.toHaveBeenCalled()
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
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('does not retain a Codex spinner terminal title when the hook reports done', async () => {
    const setAgentStatus = vi.fn()
    const updateTabTitle = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      updateTabTitle,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-future',
            ptyId: 'pty-1',
            worktreeId: 'wt-1',
            title: '\u280b Codex'
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null,
          titlesByLeafId: { [FUTURE_LEAF_ID]: '\u280b Codex' }
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
      prompt: 'codex prompt',
      agentType: 'codex',
      lastAssistantMessage: 'codex completion',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'done',
        prompt: 'codex prompt',
        agentType: 'codex',
        lastAssistantMessage: 'codex completion'
      }),
      'Codex ready',
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
    expect(updateTabTitle).toHaveBeenCalledTimes(1)
    expect(updateTabTitle).toHaveBeenCalledWith('tab-future', 'Codex ready')
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
            label: 'openclaude.exe',
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
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
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
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
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
      { updatedAt: 1_700_000_000_100, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
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
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
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
      { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 },
      expectWorktreeRouting('wt-1'),
      undefined
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

  it('silently discards stale worktree-attributed snapshots for unknown panes', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() =>
      Promise.resolve([
        {
          paneKey: ORPHAN_PANE_KEY,
          state: 'done' as const,
          prompt: 'old copilot turn',
          agentType: 'copilot',
          worktreeId: 'wt-1',
          receivedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000
        }
      ])
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Copilot' }]
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

  it('applies worktree-attributed child snapshots when runtime identity is present', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() =>
      Promise.resolve([
        {
          paneKey: ORPHAN_PANE_KEY,
          state: 'working' as const,
          prompt: 'child task',
          agentType: 'codex',
          worktreeId: 'wt-1',
          terminalHandle: 'term-child',
          orchestration: {
            taskId: 'task-child',
            dispatchId: 'dispatch-child',
            parentTerminalHandle: 'term-parent'
          },
          receivedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000
        }
      ])
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Codex' }]
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

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      ORPHAN_PANE_KEY,
      expect.objectContaining({
        state: 'working',
        prompt: 'child task',
        agentType: 'codex',
        orchestration: expect.objectContaining({ taskId: 'task-child' })
      }),
      undefined,
      { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 },
      expect.objectContaining({ worktreeId: 'wt-1', terminalHandle: 'term-child' }),
      undefined
    )
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
      { updatedAt: 1_700_000_000_100, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
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
