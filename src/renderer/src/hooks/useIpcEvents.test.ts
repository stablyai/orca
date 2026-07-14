/* eslint-disable max-lines -- Why: this test file keeps the hook wiring mocks close to the assertions so IPC event behavior stays understandable and maintainable. */
import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as IpcEventsModule from './useIpcEvents'
import {
  buildRuntimeClientEventEnvironmentKey,
  buildNewWorkspaceShortcutModalData,
  getNewlyConnectedRuntimeEnvironmentIds,
  getNewlyDisconnectedRuntimeEnvironmentIds,
  getRuntimeProjectRefreshEnvironmentIds,
  openNewWorkspaceFromShortcut,
  resolveBrowserSessionTabTarget,
  resolveZoomTarget
} from './useIpcEvents'
import {
  createHarnessStoreState,
  loadIpcEventsHarness,
  type HarnessStoreState
} from './ipc-events-test-harness'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  TEST_REPO
} from '../store/slices/store-test-helpers'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { AgentStatusClearIpcPayload } from '../../../shared/agent-status-types'
import type { TuiAgent } from '../../../shared/types'
import type * as CmdJRowIndexJump from '@/lib/cmd-j-row-index-jump'
import type { TerminalLayoutSnapshot, TuiAgent } from '../../../shared/types'
import {
  buildOrchestrationTerminalGridRoot,
  collectTerminalLayoutLeafIds
} from '../../../shared/orchestration-terminal-grid'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { YOLO_TUI_AGENT_ARGS } from '../../../shared/tui-agent-permissions'
import {
  FLOATING_WORKSPACE_GUEST_CLOSE_EVENT,
  FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT
} from '@/lib/floating-workspace-guest-bridge'

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

type TerminalSurfaceQueueTestApi = {
  queueTerminalSurfaceAction: (
    tabId: string,
    action: () => void,
    callbacks?: { onConsumed?: () => void; onCancelled?: (reason: string) => void }
  ) => () => void
  registerTerminalSurfaceActionConsumer: (tabId: string) => () => void
  cancelPendingTerminalSurfaceActions: (
    tabId: string,
    reason: 'cancelled' | 'surface-unmounted'
  ) => void
  cancelTerminalSurfaceActionsForRemovedTabs: (state: {
    tabsByWorktree: Record<string, { id: string }[]>
  }) => void
}

describe('terminal surface action queue', () => {
  const queueApi = IpcEventsModule as typeof IpcEventsModule & TerminalSurfaceQueueTestApi

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retains a split beyond five seconds and acknowledges only after its surface consumes it', () => {
    const action = vi.fn()
    const onConsumed = vi.fn()

    queueApi.queueTerminalSurfaceAction('tab-delayed', action, { onConsumed })
    vi.advanceTimersByTime(6_000)

    expect(action).not.toHaveBeenCalled()
    expect(onConsumed).not.toHaveBeenCalled()

    const unregister = queueApi.registerTerminalSurfaceActionConsumer('tab-delayed')

    expect(action).toHaveBeenCalledOnce()
    expect(onConsumed).toHaveBeenCalledOnce()
    unregister()
  })

  it('cancels a removed tab without a late split callback', () => {
    const action = vi.fn()
    const onCancelled = vi.fn()

    queueApi.queueTerminalSurfaceAction('tab-removed', action, { onCancelled })
    queueApi.cancelTerminalSurfaceActionsForRemovedTabs({ tabsByWorktree: {} })
    vi.runAllTimers()
    const unregister = queueApi.registerTerminalSurfaceActionConsumer('tab-removed')

    expect(action).not.toHaveBeenCalled()
    expect(onCancelled).toHaveBeenCalledOnce()
    expect(onCancelled).toHaveBeenCalledWith('tab-removed')
    expect(vi.getTimerCount()).toBe(0)
    unregister()
  })

  it('returns a bounded timeout failure instead of reporting an unconsumed split as successful', () => {
    const action = vi.fn()
    const onConsumed = vi.fn()
    const onCancelled = vi.fn()

    queueApi.queueTerminalSurfaceAction('tab-timeout', action, { onConsumed, onCancelled })
    vi.advanceTimersByTime(9_000)
    const unregister = queueApi.registerTerminalSurfaceActionConsumer('tab-timeout')

    expect(action).not.toHaveBeenCalled()
    expect(onConsumed).not.toHaveBeenCalled()
    expect(onCancelled).toHaveBeenCalledOnce()
    expect(onCancelled).toHaveBeenCalledWith('timeout')
    vi.runAllTimers()
    expect(onCancelled).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    unregister()
  })

  it('settles cancellation once and never replays it for a late consumer', () => {
    const action = vi.fn()
    const onCancelled = vi.fn()

    queueApi.queueTerminalSurfaceAction('tab-cancelled', action, { onCancelled })
    queueApi.cancelPendingTerminalSurfaceActions('tab-cancelled', 'cancelled')
    queueApi.cancelPendingTerminalSurfaceActions('tab-cancelled', 'surface-unmounted')
    vi.runAllTimers()
    const unregister = queueApi.registerTerminalSurfaceActionConsumer('tab-cancelled')

    expect(action).not.toHaveBeenCalled()
    expect(onCancelled).toHaveBeenCalledOnce()
    expect(onCancelled).toHaveBeenCalledWith('cancelled')
    expect(vi.getTimerCount()).toBe(0)
    unregister()
  })

  it('consumes and acknowledges immediately when the matching surface is already registered', () => {
    const action = vi.fn()
    const onConsumed = vi.fn()
    const unregister = queueApi.registerTerminalSurfaceActionConsumer('tab-mounted')

    queueApi.queueTerminalSurfaceAction('tab-mounted', action, { onConsumed })

    expect(action).toHaveBeenCalledOnce()
    expect(onConsumed).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    unregister()
  })

  it.each([
    ['mounted', true],
    ['delayed', false]
  ] as const)(
    'does not turn a throwing success callback into cancellation for a %s surface',
    (_surfaceState, registerBeforeQueue) => {
      const action = vi.fn()
      const onConsumed = vi.fn(() => {
        throw new Error('reply failed')
      })
      const onCancelled = vi.fn()
      let unregister: (() => void) | undefined

      expect(() => {
        if (registerBeforeQueue) {
          unregister = queueApi.registerTerminalSurfaceActionConsumer('tab-callback')
        }
        queueApi.queueTerminalSurfaceAction('tab-callback', action, { onConsumed, onCancelled })
        if (!registerBeforeQueue) {
          unregister = queueApi.registerTerminalSurfaceActionConsumer('tab-callback')
        }
      }).not.toThrow()

      expect(action).toHaveBeenCalledOnce()
      expect(onConsumed).toHaveBeenCalledOnce()
      expect(onCancelled).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      unregister?.()
    }
  )
})

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

describe('getNewlyDisconnectedRuntimeEnvironmentIds', () => {
  it('returns only environments whose transport was just observed down', () => {
    expect(getNewlyDisconnectedRuntimeEnvironmentIds(['env-a', 'env-b'], ['env-a'])).toEqual([
      'env-b'
    ])
    expect(getNewlyDisconnectedRuntimeEnvironmentIds(['env-a'], ['env-a', 'env-b'])).toEqual([])
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

describe('browser navigation updates', () => {
  it('commits CDP navigation URLs to the render-time cache before updating the store', async () => {
    let liveUrlDuringStoreWrite: string | null = null
    let readLiveUrl = (_browserPageId: string): string | null => null
    const setBrowserPageUrl = vi.fn((browserPageId: string) => {
      liveUrlDuringStoreWrite = readLiveUrl(browserPageId)
    })
    const updateBrowserPageState = vi.fn()
    const storeState = createHarnessStoreState({
      tabsByWorktree: {},
      setBrowserPageUrl,
      updateBrowserPageState
    })
    const harness = await loadIpcEventsHarness(storeState)
    const { clearLiveBrowserUrl, getLiveBrowserUrl } =
      await import('@/components/browser-pane/browser-runtime')
    readLiveUrl = getLiveBrowserUrl
    harness.useIpcEvents()

    harness.navigationUpdate({
      browserPageId: 'page-1',
      url: 'https://kagi.com/search?token=secret&q=next',
      title: 'Next'
    })

    expect(liveUrlDuringStoreWrite).toBe('https://kagi.com/search?q=next')
    expect(getLiveBrowserUrl('page-1')).toBe('https://kagi.com/search?q=next')
    expect(setBrowserPageUrl).toHaveBeenCalledWith(
      'page-1',
      'https://kagi.com/search?token=secret&q=next'
    )
    expect(updateBrowserPageState).toHaveBeenCalledWith('page-1', {
      title: 'Next',
      loading: false
    })
    clearLiveBrowserUrl('page-1')
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
          consumePendingOpenSettings: () => Promise.resolve(false),
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
          consumePendingOpenSettings: () => Promise.resolve(false),
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
          consumePendingOpenSettings: () => Promise.resolve(false),
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
      url: 'https://example.com'
    })

    expect(acquireBrowserAutomationVisibility).toHaveBeenCalledWith('page-new')
    expect(acquireBrowserAutomationVisibility).not.toHaveBeenCalledWith('page-active')
    expect(state.createBrowserTab).toHaveBeenCalledWith(
      'wt-1',
      'https://example.com',
      expect.objectContaining({ activate: false })
    )
    expect(state.createBrowserTab.mock.calls[0]?.[2]).not.toHaveProperty('allowWindowClose')
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

  it('opens Settings from a Settings intent queued before the listener attached', async () => {
    const openSettingsPage = vi.fn()
    let onOpenSettingsRegistered = false

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
          openSettingsPage,
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
          setUpdateStatus: vi.fn(),
          setRateLimitsFromPush: vi.fn(),
          settings: { terminalFontSize: 13 }
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
        get: (namespace, prop) =>
          prop in namespace ? Reflect.get(namespace, prop) : () => () => {}
      })

    vi.stubGlobal('window', {
      api: {
        repos: makeEvents(),
        worktrees: makeEvents(),
        keybindings: makeEvents(),
        settings: makeEvents(),
        browser: makeEvents(),
        updater: {
          getStatus: () => Promise.resolve({ state: 'idle' }),
          onStatus: () => () => {},
          onClearDismissal: () => () => {}
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
          onCredentialResolved: () => () => {},
          onPortForwardsChanged: () => () => {},
          onDetectedPortsChanged: () => () => {}
        },
        agentStatus: { onSet: () => () => {} },
        ui: makeEvents({
          onOpenSettings: () => {
            onOpenSettingsRegistered = true
            return () => {}
          },
          // Why: exercise the positive branch — an intent queued before mount is
          // pulled once the renderer's onOpenSettings listener is attached.
          consumePendingOpenSettings: () => Promise.resolve(true),
          getZoomLevel: () => 0,
          set: vi.fn()
        })
      }
    })

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    // Why: the pending-intent pull is a Promise; flush microtasks before asserting.
    await Promise.resolve()
    await Promise.resolve()

    expect(onOpenSettingsRegistered).toBe(true)
    expect(openSettingsPage).toHaveBeenCalledTimes(1)
  })

  it('clears stale remote PTYs when an SSH connection fully disconnects', async () => {
    const clearDirectSshTargetPtyBindings = vi.fn(() => 1)
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
      clearDirectSshTargetPtyBindings,
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
      settings: {
        terminalFontSize: 13,
        experimentalNativeChat: false,
        openAgentTabsInChatByDefault: false
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
    expect(clearDirectSshTargetPtyBindings).toHaveBeenCalledOnce()
    expect(clearDirectSshTargetPtyBindings).toHaveBeenCalledWith('conn-1')
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

  it('surfaces terminal creates without stealing focus unless requested', async () => {
    const createTab = vi.fn(
      (_worktreeId: string, _groupId?: string, _tabType?: string, options?: { id?: string }) => ({
        id: options?.id ?? 'tab-new'
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
    const setTabLayout = vi.fn()
    const setTabBarOrder = vi.fn()
    const replyTerminalCreate = vi.fn()
    const dispatchEvent = vi.fn((event: Event) => {
      if (event.type === 'orca-split-terminal-pane') {
        const detail = (
          event as CustomEvent<{
            acknowledge?: (result: { status: 'success'; rollback: () => void }) => void
          }>
        ).detail
        detail.acknowledge?.({ status: 'success', rollback: vi.fn() })
      }
      return true
    })
    const unsubscribeCreateTerminal = vi.fn()
    const unsubscribeStore = vi.fn()
    const createFloatingWorkspaceTerminalTab = vi.fn()
    const createWebRuntimeSessionTerminal = vi.fn().mockResolvedValue({
      status: 'failed',
      message: 'The workspace is not connected to a remote Orca host.'
    })
    const focusRuntimeTerminalSurface = vi.fn(() => false)
    const focusTerminalTabSurface = vi.fn()
    const splitSurfacingMocks = [
      setActiveView,
      setActiveWorktree,
      markWorktreeVisited,
      recordWorktreeVisit,
      setActiveTabType,
      setActiveTab,
      revealWorktreeInSidebar,
      focusRuntimeTerminalSurface,
      focusTerminalTabSurface
    ]
    const resetSplitSurfacingMocks = (): void => {
      for (const mock of splitSurfacingMocks) {
        mock.mockClear()
      }
    }
    const expectNoSplitSurfacing = (): void => {
      for (const mock of splitSurfacingMocks) {
        expect(mock).not.toHaveBeenCalled()
      }
    }
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
      folderWorkspaces: [],
      projectGroups: [],
      repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }],
      worktreesByRepo: {
        'repo-1': ['wt-1', 'wt-2', 'wt-3', 'wt-4', 'wt-history'].map((id) => ({
          id,
          repoId: 'repo-1'
        }))
      } as Record<string, { id: string; repoId: string }[]>,
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
      settings: {
        terminalFontSize: 13,
        experimentalNativeChat: false,
        openAgentTabsInChatByDefault: false,
        activeRuntimeEnvironmentId: undefined as string | undefined
      }
    }
    updateTabPtyId.mockImplementation((tabId: string, ptyId: string) => {
      storeState.ptyIdsByTabId[tabId] = [
        ...new Set([...(storeState.ptyIdsByTabId[tabId] ?? []), ptyId])
      ]
      for (const tabs of Object.values(storeState.tabsByWorktree)) {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (tab) {
          tab.ptyId = ptyId
        }
      }
    })
    setTabLayout.mockImplementation((tabId: string, layout: unknown) => {
      storeState.terminalLayoutsByTabId[tabId] = layout
    })
    const createTerminalListenerRef: {
      current:
        | ((data: {
            requestId?: string
            worktreeId: string
            command?: string
            env?: Record<string, string>
            launchConfig?: SleepingAgentLaunchConfig
            launchAgent?: TuiAgent
            viewMode?: 'terminal' | 'chat'
            title?: string
            ptyId?: string
            activate?: boolean
            focus?: boolean
            presentation?: 'background' | 'focused'
            tabId?: string
            leafId?: string
            splitFromLeafId?: string
            splitSourceLeafIds?: string[]
            splitDirection?: 'horizontal' | 'vertical'
            splitTelemetrySource?:
              | 'contextual_tour'
              | 'keyboard'
              | 'context_menu'
              | 'command'
              | 'unknown'
            placement?: 'tab' | 'orchestration-grid'
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
            cwd?: string
            launchConfig?: SleepingAgentLaunchConfig
            launchAgent?: TuiAgent
            viewMode?: 'terminal' | 'chat'
            terminalHandle?: string
            title?: string
            activate?: boolean
            presentation?: 'background' | 'focused'
            placement?: 'tab' | 'orchestration-grid'
            source?: 'runtime-session'
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
    let disposeIpcEvents: (() => void) | null = null

    vi.resetModules()
    vi.unstubAllGlobals()

    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return {
        ...actual,
        useEffect: (effect: () => void | (() => void)) => {
          disposeIpcEvents = effect() ?? null
        }
      }
    })

    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => unsubscribeStore),
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
          onActivateWorktree: () => () => {},
          onWorktreeHistoryNavigate: () => () => {},
          onCreateTerminal: (
            listener: (data: {
              requestId?: string
              worktreeId: string
              command?: string
              env?: Record<string, string>
              launchConfig?: SleepingAgentLaunchConfig
              launchAgent?: TuiAgent
              viewMode?: 'terminal' | 'chat'
              terminalHandle?: string
              title?: string
              ptyId?: string
              activate?: boolean
              focus?: boolean
              presentation?: 'background' | 'focused'
              tabId?: string
              leafId?: string
              splitFromLeafId?: string
              splitSourceLeafIds?: string[]
              splitDirection?: 'horizontal' | 'vertical'
              splitTelemetrySource?:
                | 'contextual_tour'
                | 'keyboard'
                | 'context_menu'
                | 'command'
                | 'unknown'
              placement?: 'tab' | 'orchestration-grid'
            }) => void
          ) => {
            createTerminalListenerRef.current = listener
            return unsubscribeCreateTerminal
          },
          onRequestTerminalCreate: (
            listener: (data: {
              requestId: string
              worktreeId?: string
              afterTabId?: string
              targetGroupId?: string
              command?: string
              cwd?: string
              launchConfig?: SleepingAgentLaunchConfig
              launchAgent?: TuiAgent
              viewMode?: 'terminal' | 'chat'
              terminalHandle?: string
              title?: string
              activate?: boolean
              presentation?: 'background' | 'focused'
              placement?: 'tab' | 'orchestration-grid'
            }) => void
          ) => {
            requestTerminalCreateListenerRef.current = listener
            return () => {}
          },
          onRequestTerminalTabMount: () => () => {},
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
          onResumeSleepingAgents: () => () => {},
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

    const {
      cancelPendingTerminalSurfaceActions,
      cancelTerminalSurfaceActionsForRemovedTabs,
      registerTerminalSurfaceActionConsumer,
      useIpcEvents
    } = await import('./useIpcEvents')
    useIpcEvents()
    const unregisterTabNewSurface = registerTerminalSurfaceActionConsumer('tab-new')
    const unregisterTabExistingSurface = registerTerminalSurfaceActionConsumer('tab-existing')
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

    // Exact regression sequence: Local default -> connect/navigate Windows 2 ->
    // reveal a local terminal -> restart. Connection and navigation are transient.
    storeState.repos.push({
      id: 'windows-2-repo',
      connectionId: null,
      executionHostId: 'runtime:windows-2'
    })
    storeState.worktreesByRepo['windows-2-repo'] = [
      { id: 'windows-2-worktree', repoId: 'windows-2-repo' }
    ]
    storeState.activeWorktreeId = 'windows-2-worktree'
    createTab.mockClear()
    replyTerminalCreate.mockClear()
    createTerminalListenerRef.current({
      requestId: 'local-reveal-after-remote-navigation',
      worktreeId: 'wt-2',
      title: 'Local shell',
      presentation: 'focused'
    })
    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, undefined)
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'local-reveal-after-remote-navigation',
      tabId: 'tab-new',
      title: 'Local shell'
    })
    expect(storeState.settings.activeRuntimeEnvironmentId).toBeUndefined()
    delete storeState.worktreesByRepo['windows-2-repo']
    storeState.repos = storeState.repos.filter((repo) => repo.id !== 'windows-2-repo')
    storeState.activeWorktreeId = 'wt-1'
    expect(storeState.settings.activeRuntimeEnvironmentId).toBeUndefined()

    createWebRuntimeSessionTerminal.mockClear()
    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    markWorktreeVisited.mockClear()
    recordWorktreeVisit.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()

    storeState.settings = {
      ...storeState.settings,
      activeRuntimeEnvironmentId: 'windows-2'
    }

    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      title: 'Runner',
      command: 'opencode'
    })

    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(markWorktreeVisited).not.toHaveBeenCalled()
    expect(recordWorktreeVisit).not.toHaveBeenCalled()
    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      activate: false,
      recordInteraction: false
    })
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(setTabCustomTitle).toHaveBeenCalledWith('tab-new', 'Runner', {
      recordInteraction: false
    })
    expect(queueTabStartupCommand).toHaveBeenCalledWith('tab-new', { command: 'opencode' })
    expect(storeState.settings.activeRuntimeEnvironmentId).toBe('windows-2')

    storeState.settings = {
      ...storeState.settings,
      activeRuntimeEnvironmentId: undefined
    }

    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    dispatchEvent.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      title: 'Runner',
      command: 'opencode',
      presentation: 'focused'
    })

    expect(setActiveView).toHaveBeenCalledWith('terminal')
    expect(setActiveWorktree).toHaveBeenCalledWith('wt-2')
    expect(markWorktreeVisited).toHaveBeenCalledWith('wt-2')
    expect(recordWorktreeVisit).toHaveBeenCalledWith('wt-2')
    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, undefined)
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(setActiveTab).toHaveBeenCalledWith('tab-new')
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-new', undefined)

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

    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(markWorktreeVisited).not.toHaveBeenCalled()
    expect(recordWorktreeVisit).not.toHaveBeenCalled()
    expect(createTab).toHaveBeenCalledWith('wt-3', undefined, undefined, {
      activate: false,
      recordInteraction: false
    })
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-3')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-3', tabIds: ['tab-new'] }
      })
    )
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
    storeState.settings = {
      ...storeState.settings,
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
    requestTerminalCreateListenerRef.current({
      requestId: 'req-renderer-backed',
      worktreeId: 'wt-2',
      targetGroupId: 'group-left',
      title: 'Codex',
      command: 'codex',
      cwd: '/repo/packages/app',
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'request' }
      },
      launchAgent: 'codex',
      activate: false
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', 'group-left', undefined, {
      activate: false,
      recordInteraction: false,
      launchAgent: 'codex',
      viewMode: 'chat',
      startupCwd: '/repo/packages/app'
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(markWorktreeVisited).not.toHaveBeenCalled()
    expect(recordWorktreeVisit).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-new', undefined)
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-2', tabIds: ['tab-new'] }
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

    createTab.mockClear()
    setTabLayout.mockClear()
    setTabCustomTitle.mockClear()
    queueTabStartupCommand.mockClear()
    replyTerminalCreate.mockClear()
    dispatchEvent.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    requestTerminalCreateListenerRef.current({
      requestId: 'req-grid-first',
      worktreeId: 'wt-grid',
      title: 'Worker 1',
      terminalHandle: 'term-grid-first',
      placement: 'orchestration-grid'
    })

    expect(createTab).toHaveBeenCalledOnce()
    const firstGridLayout = setTabLayout.mock.calls.at(-1)?.[1] as TerminalLayoutSnapshot
    expect(firstGridLayout).toMatchObject({
      layoutMode: 'orchestration-grid',
      root: { type: 'leaf' }
    })
    expect(Object.values(firstGridLayout.titlesByLeafId ?? {})).toEqual(['Worker 1'])
    expect(setTabCustomTitle).toHaveBeenCalledOnce()
    expect(setTabCustomTitle).toHaveBeenCalledWith('tab-new', 'Worker 1', {
      recordInteraction: false
    })
    expect(queueTabStartupCommand).toHaveBeenCalledOnce()
    expect(queueTabStartupCommand).toHaveBeenCalledWith(
      'tab-new',
      expect.objectContaining({
        command: '',
        env: { ORCA_TERMINAL_HANDLE: 'term-grid-first' }
      })
    )
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-grid-first',
      tabId: 'tab-new',
      leafId: expect.any(String),
      title: 'Worker 1'
    })

    storeState.tabsByWorktree['wt-grid'] = [{ id: 'tab-new', title: 'Worker grid' }]
    storeState.terminalLayoutsByTabId = { 'tab-new': firstGridLayout }
    resetSplitSurfacingMocks()
    createTab.mockClear()
    setTabLayout.mockClear()
    setTabCustomTitle.mockClear()
    queueTabStartupCommand.mockClear()
    replyTerminalCreate.mockClear()
    dispatchEvent.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    unregisterTabNewSurface()
    vi.useFakeTimers()
    requestTerminalCreateListenerRef.current({
      requestId: 'req-grid-second',
      worktreeId: 'wt-grid',
      title: 'Worker 2',
      command: 'codex',
      placement: 'orchestration-grid'
    })

    expect(createTab).not.toHaveBeenCalled()
    expect(queueTabStartupCommand).not.toHaveBeenCalled()
    expect(setTabLayout).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'orca-split-terminal-pane' })
    )
    expect(replyTerminalCreate).not.toHaveBeenCalled()
    expectNoSplitSurfacing()

    vi.advanceTimersByTime(6_000)

    expect(setTabLayout).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'orca-split-terminal-pane' })
    )
    expect(replyTerminalCreate).not.toHaveBeenCalled()
    expectNoSplitSurfacing()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-grid', tabIds: ['tab-new'] }
      })
    )
    dispatchEvent.mockClear()

    const unregisterRemountedTabNewSurface = registerTerminalSurfaceActionConsumer('tab-new')
    vi.useRealTimers()

    expect(setTabLayout).toHaveBeenCalledWith(
      'tab-new',
      expect.objectContaining({ layoutMode: 'orchestration-grid' })
    )
    const backgroundGridLayout = setTabLayout.mock.calls.at(-1)?.[1] as TerminalLayoutSnapshot
    expect(Object.values(backgroundGridLayout.titlesByLeafId ?? {})).toEqual([
      'Worker 1',
      'Worker 2'
    ])
    expect(setTabCustomTitle).not.toHaveBeenCalled()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-split-terminal-pane',
        detail: expect.objectContaining({
          tabId: 'tab-new',
          direction: 'vertical',
          activate: false,
          orchestrationGrid: true,
          sourceLeafIds: [expect.any(String)],
          startup: expect.objectContaining({ command: 'codex' })
        })
      })
    )
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-grid-second',
      tabId: 'tab-new',
      leafId: expect.any(String),
      layout: backgroundGridLayout,
      title: 'Worker 2'
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-grid')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith(
      'tab-new',
      firstGridLayout.activeLeafId
    )
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-new', firstGridLayout.activeLeafId)
    expect(dispatchEvent.mock.invocationCallOrder[0]).toBeLessThan(
      setTabLayout.mock.invocationCallOrder[0] ?? 0
    )
    expect(setTabLayout.mock.invocationCallOrder[0]).toBeLessThan(
      revealWorktreeInSidebar.mock.invocationCallOrder[0] ?? 0
    )
    expect(revealWorktreeInSidebar.mock.invocationCallOrder[0]).toBeLessThan(
      focusRuntimeTerminalSurface.mock.invocationCallOrder[0] ?? 0
    )
    expect(focusRuntimeTerminalSurface.mock.invocationCallOrder[0]).toBeLessThan(
      replyTerminalCreate.mock.invocationCallOrder[0] ?? 0
    )

    storeState.terminalLayoutsByTabId = { 'tab-new': backgroundGridLayout }
    setTabLayout.mockClear()
    setTabCustomTitle.mockClear()
    replyTerminalCreate.mockClear()
    dispatchEvent.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    requestTerminalCreateListenerRef.current({
      requestId: 'req-grid-third-focused',
      worktreeId: 'wt-grid',
      title: 'Worker 3',
      command: 'codex',
      activate: true,
      placement: 'orchestration-grid'
    })

    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-split-terminal-pane',
        detail: expect.objectContaining({
          tabId: 'tab-new',
          activate: true,
          orchestrationGrid: true
        })
      })
    )
    const focusedGridLayout = setTabLayout.mock.calls.at(-1)?.[1] as TerminalLayoutSnapshot
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-grid-third-focused',
      tabId: 'tab-new',
      leafId: expect.any(String),
      layout: focusedGridLayout,
      title: 'Worker 3'
    })
    expect(Object.values(focusedGridLayout.titlesByLeafId ?? {})).toEqual([
      'Worker 1',
      'Worker 2',
      'Worker 3'
    ])
    expect(setTabCustomTitle).not.toHaveBeenCalled()
    const focusedGridDetail = (
      dispatchEvent.mock.calls
        .map(([event]) => event)
        .find((event) => event.type === 'orca-split-terminal-pane') as
        | CustomEvent<{ newLeafId?: string }>
        | undefined
    )?.detail
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith(
      'tab-new',
      focusedGridDetail?.newLeafId
    )
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-new', focusedGridDetail?.newLeafId)
    unregisterRemountedTabNewSurface()

    storeState.terminalLayoutsByTabId = { 'tab-new': focusedGridLayout }
    resetSplitSurfacingMocks()
    setTabLayout.mockClear()
    replyTerminalCreate.mockClear()
    dispatchEvent.mockClear()
    vi.useFakeTimers()
    requestTerminalCreateListenerRef.current({
      requestId: 'req-grid-focused-timeout',
      worktreeId: 'wt-grid',
      title: 'Worker timeout',
      command: 'codex',
      activate: true,
      placement: 'orchestration-grid'
    })

    expect(setTabLayout).not.toHaveBeenCalled()
    expect(replyTerminalCreate).not.toHaveBeenCalled()
    expectNoSplitSurfacing()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-grid', tabIds: ['tab-new'] }
      })
    )
    vi.advanceTimersByTime(9_000)
    const unregisterTimedOutGridSurface = registerTerminalSurfaceActionConsumer('tab-new')
    vi.runAllTimers()

    expect(setTabLayout).not.toHaveBeenCalled()
    expect(
      dispatchEvent.mock.calls.filter(([event]) => event.type === 'orca-split-terminal-pane')
    ).toHaveLength(0)
    expectNoSplitSurfacing()
    expect(replyTerminalCreate).toHaveBeenCalledOnce()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-grid-focused-timeout',
      error: 'Terminal surface tab-new did not mount before the split deadline'
    })
    expect(vi.getTimerCount()).toBe(0)
    unregisterTimedOutGridSurface()
    vi.useRealTimers()

    const requestGridCancellationCases = [
      {
        requestId: 'req-grid-focused-cancelled',
        cancel: () => cancelPendingTerminalSurfaceActions('tab-new', 'cancelled'),
        error: 'Terminal split was cancelled for tab-new'
      },
      {
        requestId: 'req-grid-focused-unmounted',
        cancel: () => cancelPendingTerminalSurfaceActions('tab-new', 'surface-unmounted'),
        error: 'Terminal surface tab-new was torn down before the split was applied'
      },
      {
        requestId: 'req-grid-focused-removed',
        cancel: () => cancelTerminalSurfaceActionsForRemovedTabs({ tabsByWorktree: {} }),
        error: 'Terminal tab tab-new was removed before the split was applied'
      }
    ]
    for (const cancellationCase of requestGridCancellationCases) {
      resetSplitSurfacingMocks()
      setTabLayout.mockClear()
      replyTerminalCreate.mockClear()
      dispatchEvent.mockClear()
      vi.useFakeTimers()
      requestTerminalCreateListenerRef.current({
        requestId: cancellationCase.requestId,
        worktreeId: 'wt-grid',
        title: 'Worker cancelled',
        command: 'codex',
        activate: true,
        placement: 'orchestration-grid'
      })

      expectNoSplitSurfacing()
      cancellationCase.cancel()
      cancellationCase.cancel()
      vi.runAllTimers()
      const unregisterCancelledGridSurface = registerTerminalSurfaceActionConsumer('tab-new')

      expect(storeState.terminalLayoutsByTabId['tab-new']).toBe(focusedGridLayout)
      expect(setTabLayout).not.toHaveBeenCalled()
      expect(
        dispatchEvent.mock.calls.filter(([event]) => event.type === 'orca-split-terminal-pane')
      ).toHaveLength(0)
      expectNoSplitSurfacing()
      expect(replyTerminalCreate).toHaveBeenCalledOnce()
      expect(replyTerminalCreate).toHaveBeenCalledWith({
        requestId: cancellationCase.requestId,
        error: cancellationCase.error
      })
      expect(vi.getTimerCount()).toBe(0)
      unregisterCancelledGridSurface()
      vi.useRealTimers()
    }

    createTab.mockClear()
    replyTerminalCreate.mockClear()
    storeState.settings.activeRuntimeEnvironmentId = 'focused-runtime'
    requestTerminalCreateListenerRef.current({
      requestId: 'req-runtime-session',
      worktreeId: 'wt-2',
      targetGroupId: 'group-left',
      title: 'Runtime Terminal',
      command: 'codex',
      launchAgent: 'codex',
      viewMode: 'terminal',
      activate: true,
      source: 'runtime-session'
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', 'group-left', undefined, {
      launchAgent: 'codex',
      viewMode: 'terminal'
    })
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-runtime-session',
      tabId: 'tab-new',
      title: 'Runtime Terminal'
    })

    createTab.mockClear()
    replyTerminalCreate.mockClear()
    storeState.settings.activeRuntimeEnvironmentId = 'focused-runtime'
    requestTerminalCreateListenerRef.current({
      requestId: 'req-runtime-blocked',
      worktreeId: 'wt-2',
      title: 'Blocked Local Terminal'
    })

    expect(createTab).toHaveBeenCalled()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-runtime-blocked',
      tabId: 'tab-new',
      title: 'Blocked Local Terminal'
    })

    createTab.mockClear()
    replyTerminalCreate.mockClear()
    storeState.repos = [
      ...storeState.repos,
      {
        id: 'repo-remote',
        connectionId: null,
        executionHostId: 'runtime:focused-runtime'
      }
    ]
    storeState.worktreesByRepo = {
      ...storeState.worktreesByRepo,
      'repo-remote': [{ id: 'wt-remote', repoId: 'repo-remote' }]
    }
    requestTerminalCreateListenerRef.current({
      requestId: 'req-remote-owner-blocked',
      worktreeId: 'wt-remote',
      title: 'Remote-owned Terminal'
    })
    expect(createTab).not.toHaveBeenCalled()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-remote-owner-blocked',
      error: 'Local terminal creation is unavailable while a remote runtime is active'
    })
    delete storeState.worktreesByRepo['repo-remote']
    storeState.repos = storeState.repos.filter((repo) => repo.id !== 'repo-remote')

    createTab.mockClear()
    replyTerminalCreate.mockClear()
    storeState.repos = [
      ...storeState.repos,
      {
        id: 'repo-conflicting-owner',
        connectionId: null,
        executionHostId: 'runtime:focused-runtime'
      }
    ]
    storeState.worktreesByRepo = {
      ...storeState.worktreesByRepo,
      'repo-1': [...storeState.worktreesByRepo['repo-1'], { id: 'wt-ambiguous', repoId: 'repo-1' }],
      'repo-conflicting-owner': [{ id: 'wt-ambiguous', repoId: 'repo-conflicting-owner' }]
    }
    requestTerminalCreateListenerRef.current({
      requestId: 'req-ambiguous-owner',
      worktreeId: 'wt-ambiguous',
      title: 'Ambiguous Terminal',
      source: 'runtime-session'
    })
    expect(createTab).not.toHaveBeenCalled()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-ambiguous-owner',
      error: 'Terminal creation is unavailable because the worktree owner could not be resolved'
    })
    storeState.worktreesByRepo['repo-1'] = storeState.worktreesByRepo['repo-1'].filter(
      (worktree) => worktree.id !== 'wt-ambiguous'
    )
    delete storeState.worktreesByRepo['repo-conflicting-owner']
    storeState.repos = storeState.repos.filter((repo) => repo.id !== 'repo-conflicting-owner')

    createTab.mockClear()
    replyTerminalCreate.mockClear()
    requestTerminalCreateListenerRef.current({
      requestId: 'req-missing-owner',
      worktreeId: 'wt-missing',
      title: 'Missing Terminal'
    })
    expect(createTab).not.toHaveBeenCalled()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-missing-owner',
      error: 'Terminal creation is unavailable because the worktree owner could not be resolved'
    })
    storeState.settings.activeRuntimeEnvironmentId = undefined

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
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    replyTerminalCreate.mockClear()
    dispatchEvent.mockClear()
    requestTerminalCreateListenerRef.current({
      requestId: 'req-renderer-backed-background',
      worktreeId: 'wt-2',
      title: 'Codex',
      command: 'codex',
      presentation: 'background'
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
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
        detail: { worktreeId: 'wt-2', tabIds: ['tab-new'] }
      })
    )
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-renderer-backed-background',
      tabId: 'tab-new',
      title: 'Codex'
    })

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
      activate: false,
      launchAgent: 'codex',
      viewMode: 'chat'
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
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
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-explicit-terminal',
      launchAgent: 'codex',
      viewMode: 'terminal'
    })
    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-explicit-terminal',
      activate: false,
      launchAgent: 'codex',
      viewMode: 'terminal'
    })

    createTab.mockClear()
    storeState.settings.openAgentTabsInChatByDefault = false
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-explicit-chat',
      launchAgent: 'codex',
      viewMode: 'chat'
    })
    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-explicit-chat',
      activate: false,
      launchAgent: 'codex',
      viewMode: 'chat'
    })
    storeState.settings.openAgentTabsInChatByDefault = true

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
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')

    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    dispatchEvent.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-bg-3',
      presentation: 'background',
      tabId: 'tab-cli-bg-reveal'
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-bg-3',
      activate: false,
      id: 'tab-cli-bg-reveal'
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).not.toHaveBeenCalled()
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-2', tabIds: ['tab-cli-bg-reveal'] }
      })
    )

    createTab.mockClear()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    dispatchEvent.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-recovery-bg',
      activate: true,
      focus: false,
      tabId: 'tab-recovery-bg'
    })

    expect(createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-recovery-bg',
      activate: false,
      id: 'tab-recovery-bg'
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).not.toHaveBeenCalled()
    expect(focusRuntimeTerminalSurface).not.toHaveBeenCalled()
    expect(focusTerminalTabSurface).not.toHaveBeenCalled()
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-2', tabIds: ['tab-recovery-bg'] }
      })
    )

    storeState.tabsByWorktree = {
      'wt-2': [{ id: 'tab-existing', ptyId: 'pty-bg', title: 'Terminal 1' }]
    }
    storeState.ptyIdsByTabId = { 'tab-existing': ['pty-bg'] }
    createTab.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    setTabCustomTitle.mockClear()
    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-bg',
      title: 'Runtime title'
    })

    expect(createTab).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
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
    revealWorktreeInSidebar.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
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
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith(pendingTabId, pendingLeafId)
    expect(focusTerminalTabSurface).toHaveBeenCalledWith(pendingTabId, pendingLeafId)
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-adopt-pending',
      tabId: pendingTabId,
      title: 'Terminal 3',
      identity: {
        worktreeId: 'wt-2',
        tabId: pendingTabId,
        leafId: pendingLeafId,
        ptyId: 'serve-cf39bedb-a33a-417c-9ab6-f304dc27a6c0'
      }
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
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    markWorktreeVisited.mockClear()
    recordWorktreeVisit.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    updateTabPtyId.mockClear()
    setTabLayout.mockClear()
    queueTabStartupCommand.mockClear()
    replyTerminalCreate.mockClear()
    dispatchEvent.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    createTerminalListenerRef.current({
      requestId: 'req-split',
      worktreeId: 'wt-2',
      command: 'codex --resume',
      env: { ORCA_WORKER: 'ordinary' },
      title: 'Split worker',
      ptyId: 'pty-split',
      tabId: 'tab-existing',
      leafId: 'leaf-split',
      splitFromLeafId: 'leaf-source',
      splitDirection: 'vertical',
      splitTelemetrySource: 'contextual_tour',
      presentation: 'focused'
    })

    expect(createTab).not.toHaveBeenCalled()
    expect(updateTabPtyId).toHaveBeenCalledOnce()
    expect(updateTabPtyId).toHaveBeenCalledWith('tab-existing', 'pty-split')
    expect(setTabLayout).toHaveBeenCalledOnce()
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
      },
      titlesByLeafId: {
        'leaf-split': 'Split worker'
      }
    })
    expect(queueTabStartupCommand).not.toHaveBeenCalled()
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-split-terminal-pane',
        detail: expect.objectContaining({
          tabId: 'tab-existing',
          paneRuntimeId: -1,
          direction: 'vertical',
          sourceLeafId: 'leaf-source',
          sourcePtyId: 'pty-bg',
          telemetrySource: 'contextual_tour',
          newLeafId: 'leaf-split',
          ptyId: 'pty-split',
          startup: {
            command: 'codex --resume',
            env: { ORCA_WORKER: 'ordinary' }
          },
          activate: true
        })
      })
    )
    expect(replyTerminalCreate).toHaveBeenCalledOnce()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-split',
      tabId: 'tab-existing',
      title: 'Terminal 1',
      identity: {
        worktreeId: 'wt-2',
        tabId: 'tab-existing',
        leafId: 'leaf-split',
        ptyId: 'pty-split'
      }
      leafId: 'leaf-split',
      layout: setTabLayout.mock.calls.at(-1)?.[1],
      title: 'Split worker'
    })
    expect(setActiveView).toHaveBeenCalledWith('terminal')
    expect(setActiveWorktree).toHaveBeenCalledWith('wt-2')
    expect(markWorktreeVisited).toHaveBeenCalledWith('wt-2')
    expect(recordWorktreeVisit).toHaveBeenCalledWith('wt-2')
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(setActiveTab).toHaveBeenCalledWith('tab-existing')
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(dispatchEvent.mock.invocationCallOrder[0]).toBeLessThan(
      setTabLayout.mock.invocationCallOrder[0] ?? 0
    )
    expect(setTabLayout.mock.invocationCallOrder[0]).toBeLessThan(
      updateTabPtyId.mock.invocationCallOrder[0] ?? 0
    )
    expect(updateTabPtyId.mock.invocationCallOrder[0]).toBeLessThan(
      setActiveTab.mock.invocationCallOrder[0] ?? 0
    )
    expect(setActiveTab.mock.invocationCallOrder[0]).toBeLessThan(
      revealWorktreeInSidebar.mock.invocationCallOrder[0] ?? 0
    )
    expect(revealWorktreeInSidebar.mock.invocationCallOrder[0]).toBeLessThan(
      focusRuntimeTerminalSurface.mock.invocationCallOrder[0] ?? 0
    )
    expect(focusRuntimeTerminalSurface.mock.invocationCallOrder[0]).toBeLessThan(
      replyTerminalCreate.mock.invocationCallOrder[0] ?? 0
    )

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

    expect(updateTabPtyId).toHaveBeenCalledOnce()
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

    const delayedGridLayout: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'leaf-grid-a' },
        second: { type: 'leaf', leafId: 'leaf-grid-b' },
        ratio: 0.5
      },
      activeLeafId: 'leaf-grid-a',
      expandedLeafId: null,
      layoutMode: 'orchestration-grid',
      ptyIdsByLeafId: { 'leaf-grid-a': 'pty-grid-a', 'leaf-grid-b': 'pty-grid-b' },
      titlesByLeafId: { 'leaf-grid-a': 'Worker A', 'leaf-grid-b': 'Worker B' }
    }
    const delayedGridLeafId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const delayedGridLaunchConfig = {
      agentArgs: '--resume',
      agentEnv: { ORCA_WORKER: 'c' }
    }
    storeState.ptyIdsByTabId = { 'tab-existing': ['pty-grid-a', 'pty-grid-b'] }
    storeState.terminalLayoutsByTabId = { 'tab-existing': delayedGridLayout }
    setTabLayout.mockImplementation((targetTabId: string, layout: TerminalLayoutSnapshot) => {
      storeState.terminalLayoutsByTabId[targetTabId] = layout
    })
    unregisterTabExistingSurface()
    setActiveView.mockClear()
    setActiveWorktree.mockClear()
    markWorktreeVisited.mockClear()
    recordWorktreeVisit.mockClear()
    setActiveTabType.mockClear()
    setActiveTab.mockClear()
    revealWorktreeInSidebar.mockClear()
    updateTabPtyId.mockClear()
    setTabLayout.mockClear()
    queueTabStartupCommand.mockClear()
    registerAgentLaunchConfig.mockClear()
    replyTerminalCreate.mockClear()
    dispatchEvent.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    vi.useFakeTimers()

    createTerminalListenerRef.current({
      requestId: 'req-grid-delayed',
      worktreeId: 'wt-2',
      command: 'codex --resume',
      env: { ORCA_WORKER: 'c' },
      launchConfig: delayedGridLaunchConfig,
      launchAgent: 'codex',
      title: 'Worker C',
      ptyId: 'pty-grid-c',
      tabId: 'tab-existing',
      leafId: delayedGridLeafId,
      splitFromLeafId: 'leaf-grid-b',
      splitSourceLeafIds: ['leaf-grid-a', 'leaf-grid-b'],
      splitDirection: 'vertical',
      placement: 'orchestration-grid',
      activate: false
    })

    const layoutBeforeDelayedMount = storeState.terminalLayoutsByTabId['tab-existing']
    const layoutWritesBeforeDelayedMount = setTabLayout.mock.calls.length
    const splitEventsBeforeDelayedMount = dispatchEvent.mock.calls.filter(
      ([event]) => event.type === 'orca-split-terminal-pane'
    ).length
    const repliesBeforeDelayedMount = replyTerminalCreate.mock.calls.length
    vi.advanceTimersByTime(6_000)
    const repliesAfterSixSeconds = replyTerminalCreate.mock.calls.length

    expect(layoutBeforeDelayedMount).toBe(delayedGridLayout)
    expect(layoutWritesBeforeDelayedMount).toBe(0)
    expect(splitEventsBeforeDelayedMount).toBe(0)
    expect(repliesBeforeDelayedMount).toBe(0)
    expect(repliesAfterSixSeconds).toBe(0)
    expect(updateTabPtyId).not.toHaveBeenCalled()
    expect(queueTabStartupCommand).not.toHaveBeenCalled()
    expect(registerAgentLaunchConfig).not.toHaveBeenCalled()
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(markWorktreeVisited).not.toHaveBeenCalled()
    expect(recordWorktreeVisit).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).not.toHaveBeenCalled()
    expect(focusRuntimeTerminalSurface).not.toHaveBeenCalled()
    expect(focusTerminalTabSurface).not.toHaveBeenCalled()

    const unregisterDelayedGridSurface = registerTerminalSurfaceActionConsumer('tab-existing')
    vi.useRealTimers()

    expect(updateTabPtyId).toHaveBeenCalledOnce()
    expect(updateTabPtyId).toHaveBeenCalledWith('tab-existing', 'pty-grid-c')
    expect(queueTabStartupCommand).not.toHaveBeenCalled()
    expect(registerAgentLaunchConfig).not.toHaveBeenCalled()
    expect(setTabLayout).toHaveBeenCalledOnce()
    expect(storeState.terminalLayoutsByTabId['tab-existing']).toEqual({
      root: {
        type: 'split',
        direction: 'vertical',
        first: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'leaf-grid-a' },
          second: { type: 'leaf', leafId: 'leaf-grid-b' },
          ratio: 0.5
        },
        second: { type: 'leaf', leafId: delayedGridLeafId },
        ratio: 2 / 3
      },
      activeLeafId: 'leaf-grid-a',
      expandedLeafId: null,
      layoutMode: 'orchestration-grid',
      ptyIdsByLeafId: {
        'leaf-grid-a': 'pty-grid-a',
        'leaf-grid-b': 'pty-grid-b',
        [delayedGridLeafId]: 'pty-grid-c'
      },
      titlesByLeafId: {
        'leaf-grid-a': 'Worker A',
        'leaf-grid-b': 'Worker B',
        [delayedGridLeafId]: 'Worker C'
      }
    })
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-split-terminal-pane',
        detail: expect.objectContaining({
          tabId: 'tab-existing',
          sourceLeafId: 'leaf-grid-b',
          sourceLeafIds: ['leaf-grid-a', 'leaf-grid-b'],
          sourcePtyId: 'pty-grid-b',
          newLeafId: delayedGridLeafId,
          ptyId: 'pty-grid-c',
          startup: {
            command: 'codex --resume',
            env: { ORCA_WORKER: 'c' },
            launchConfig: delayedGridLaunchConfig,
            launchAgent: 'codex'
          },
          activate: false,
          orchestrationGrid: true
        })
      })
    )
    expect(replyTerminalCreate).toHaveBeenCalledOnce()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-grid-delayed',
      tabId: 'tab-existing',
      leafId: delayedGridLeafId,
      layout: setTabLayout.mock.calls.at(-1)?.[1],
      title: 'Worker C'
    })
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
    expect(setActiveTab).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-existing', 'leaf-grid-a')
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-existing', 'leaf-grid-a')
    expect(dispatchEvent.mock.invocationCallOrder[0]).toBeLessThan(
      setTabLayout.mock.invocationCallOrder[0] ?? 0
    )
    expect(setTabLayout.mock.invocationCallOrder[0]).toBeLessThan(
      updateTabPtyId.mock.invocationCallOrder[0] ?? 0
    )
    expect(updateTabPtyId.mock.invocationCallOrder[0]).toBeLessThan(
      revealWorktreeInSidebar.mock.invocationCallOrder[0] ?? 0
    )
    expect(revealWorktreeInSidebar.mock.invocationCallOrder[0]).toBeLessThan(
      focusRuntimeTerminalSurface.mock.invocationCallOrder[0] ?? 0
    )
    expect(focusRuntimeTerminalSurface.mock.invocationCallOrder[0]).toBeLessThan(
      replyTerminalCreate.mock.invocationCallOrder[0] ?? 0
    )

    setActiveTab.mockClear()
    setTabLayout.mockClear()
    replyTerminalCreate.mockClear()
    dispatchEvent.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    createTerminalListenerRef.current({
      requestId: 'req-grid-mounted',
      worktreeId: 'wt-2',
      title: 'Worker D',
      ptyId: 'pty-grid-d',
      tabId: 'tab-existing',
      leafId: 'leaf-grid-d',
      splitFromLeafId: delayedGridLeafId,
      splitSourceLeafIds: ['leaf-grid-a', 'leaf-grid-b', delayedGridLeafId],
      splitDirection: 'vertical',
      placement: 'orchestration-grid',
      activate: true
    })

    expect(setTabLayout).toHaveBeenCalledOnce()
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(replyTerminalCreate).toHaveBeenCalledOnce()
    expect(storeState.terminalLayoutsByTabId['tab-existing']).toMatchObject({
      root: {
        type: 'split',
        direction: 'vertical',
        first: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'leaf-grid-a' },
          second: { type: 'leaf', leafId: 'leaf-grid-b' },
          ratio: 0.5
        },
        second: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: delayedGridLeafId },
          second: { type: 'leaf', leafId: 'leaf-grid-d' },
          ratio: 0.5
        },
        ratio: 0.5
      },
      activeLeafId: 'leaf-grid-d',
      ptyIdsByLeafId: { 'leaf-grid-d': 'pty-grid-d' },
      titlesByLeafId: { 'leaf-grid-d': 'Worker D' }
    })
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-grid-mounted',
      tabId: 'tab-existing',
      leafId: 'leaf-grid-d',
      layout: setTabLayout.mock.calls.at(-1)?.[1],
      title: 'Worker D'
    })
    expect(setActiveTab).toHaveBeenCalledWith('tab-existing')
    expect(focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-existing', 'leaf-grid-d')
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('tab-existing', 'leaf-grid-d')
    unregisterDelayedGridSurface()

    const layoutBeforeCancelledAppends = storeState.terminalLayoutsByTabId['tab-existing']
    resetSplitSurfacingMocks()
    updateTabPtyId.mockClear()
    setTabLayout.mockClear()
    queueTabStartupCommand.mockClear()
    registerAgentLaunchConfig.mockClear()
    replyTerminalCreate.mockClear()
    dispatchEvent.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    vi.useFakeTimers()
    createTerminalListenerRef.current({
      requestId: 'req-grid-timeout',
      worktreeId: 'wt-2',
      command: 'codex --timeout',
      env: { ORCA_WORKER: 'timeout' },
      launchConfig: { agentArgs: '--resume', agentEnv: { ORCA_WORKER: 'timeout' } },
      launchAgent: 'codex',
      ptyId: 'pty-grid-timeout',
      tabId: 'tab-existing',
      leafId: '66666666-6666-4666-8666-666666666666',
      splitFromLeafId: 'leaf-grid-d',
      splitDirection: 'vertical',
      placement: 'orchestration-grid',
      activate: true
    })
    vi.advanceTimersByTime(9_000)
    const unregisterAfterTimeout = registerTerminalSurfaceActionConsumer('tab-existing')
    vi.runAllTimers()

    expect(storeState.terminalLayoutsByTabId['tab-existing']).toBe(layoutBeforeCancelledAppends)
    expect(updateTabPtyId).not.toHaveBeenCalled()
    expect(setTabLayout).not.toHaveBeenCalled()
    expect(queueTabStartupCommand).not.toHaveBeenCalled()
    expect(registerAgentLaunchConfig).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()
    expectNoSplitSurfacing()
    expect(replyTerminalCreate).toHaveBeenCalledOnce()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-grid-timeout',
      error: 'Terminal surface tab-existing did not mount before the split deadline'
    })
    expect(vi.getTimerCount()).toBe(0)
    unregisterAfterTimeout()
    vi.useRealTimers()

    const cancellationCases = [
      {
        requestId: 'req-grid-cancelled',
        leafId: '77777777-7777-4777-8777-777777777777',
        cancel: () => cancelPendingTerminalSurfaceActions('tab-existing', 'cancelled'),
        error: 'Terminal split was cancelled for tab-existing'
      },
      {
        requestId: 'req-grid-unmounted',
        leafId: '88888888-8888-4888-8888-888888888888',
        cancel: () => cancelPendingTerminalSurfaceActions('tab-existing', 'surface-unmounted'),
        error: 'Terminal surface tab-existing was torn down before the split was applied'
      },
      {
        requestId: 'req-grid-removed',
        leafId: '99999999-9999-4999-8999-999999999999',
        cancel: () => cancelTerminalSurfaceActionsForRemovedTabs({ tabsByWorktree: {} }),
        error: 'Terminal tab tab-existing was removed before the split was applied'
      }
    ]
    for (const cancellationCase of cancellationCases) {
      resetSplitSurfacingMocks()
      updateTabPtyId.mockClear()
      setTabLayout.mockClear()
      queueTabStartupCommand.mockClear()
      registerAgentLaunchConfig.mockClear()
      replyTerminalCreate.mockClear()
      dispatchEvent.mockClear()
      focusRuntimeTerminalSurface.mockClear()
      focusTerminalTabSurface.mockClear()
      vi.useFakeTimers()
      createTerminalListenerRef.current({
        requestId: cancellationCase.requestId,
        worktreeId: 'wt-2',
        command: 'codex --cancelled',
        env: { ORCA_WORKER: 'cancelled' },
        launchConfig: { agentArgs: '--resume', agentEnv: { ORCA_WORKER: 'cancelled' } },
        launchAgent: 'codex',
        ptyId: `pty-${cancellationCase.leafId}`,
        tabId: 'tab-existing',
        leafId: cancellationCase.leafId,
        splitFromLeafId: 'leaf-grid-d',
        splitDirection: 'vertical',
        placement: 'orchestration-grid',
        activate: true
      })
      cancellationCase.cancel()
      cancellationCase.cancel()
      vi.runAllTimers()
      const unregisterAfterCancellation = registerTerminalSurfaceActionConsumer('tab-existing')

      expect(storeState.terminalLayoutsByTabId['tab-existing']).toBe(layoutBeforeCancelledAppends)
      expect(updateTabPtyId).not.toHaveBeenCalled()
      expect(setTabLayout).not.toHaveBeenCalled()
      expect(queueTabStartupCommand).not.toHaveBeenCalled()
      expect(registerAgentLaunchConfig).not.toHaveBeenCalled()
      expect(dispatchEvent).not.toHaveBeenCalled()
      expectNoSplitSurfacing()
      expect(replyTerminalCreate).toHaveBeenCalledOnce()
      expect(replyTerminalCreate).toHaveBeenCalledWith({
        requestId: cancellationCase.requestId,
        error: cancellationCase.error
      })
      expect(vi.getTimerCount()).toBe(0)
      unregisterAfterCancellation()
      vi.useRealTimers()
    }

    resetSplitSurfacingMocks()
    updateTabPtyId.mockClear()
    setTabLayout.mockClear()
    queueTabStartupCommand.mockClear()
    registerAgentLaunchConfig.mockClear()
    replyTerminalCreate.mockClear()
    dispatchEvent.mockClear()
    focusRuntimeTerminalSurface.mockClear()
    focusTerminalTabSurface.mockClear()
    storeState.tabsByWorktree['wt-grid'] = [{ id: 'tab-new', title: 'Worker grid' }]
    storeState.terminalLayoutsByTabId['tab-new'] = focusedGridLayout
    vi.useFakeTimers()
    createTerminalListenerRef.current({
      requestId: 'req-grid-disposed',
      worktreeId: 'wt-2',
      command: 'codex --disposed',
      env: { ORCA_WORKER: 'disposed' },
      launchConfig: { agentArgs: '--resume', agentEnv: { ORCA_WORKER: 'disposed' } },
      launchAgent: 'codex',
      ptyId: 'pty-grid-disposed',
      tabId: 'tab-existing',
      leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      splitFromLeafId: 'leaf-grid-d',
      splitDirection: 'vertical',
      placement: 'orchestration-grid',
      activate: true
    })
    requestTerminalCreateListenerRef.current({
      requestId: 'req-request-grid-disposed',
      worktreeId: 'wt-grid',
      title: 'Worker disposed',
      command: 'codex',
      activate: true,
      placement: 'orchestration-grid'
    })
    const dispose = disposeIpcEvents as (() => void) | null
    if (!dispose) {
      throw new Error('Expected useIpcEvents cleanup to be registered')
    }
    dispose()
    vi.runAllTimers()
    const unregisterAfterDisposal = registerTerminalSurfaceActionConsumer('tab-existing')
    const unregisterRequestGridAfterDisposal = registerTerminalSurfaceActionConsumer('tab-new')

    expect(storeState.terminalLayoutsByTabId['tab-existing']).toBe(layoutBeforeCancelledAppends)
    expect(updateTabPtyId).not.toHaveBeenCalled()
    expect(setTabLayout).not.toHaveBeenCalled()
    expect(queueTabStartupCommand).not.toHaveBeenCalled()
    expect(registerAgentLaunchConfig).not.toHaveBeenCalled()
    expect(
      dispatchEvent.mock.calls.filter(([event]) => event.type === 'orca-split-terminal-pane')
    ).toHaveLength(0)
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-background-mount-terminal-worktree',
        detail: { worktreeId: 'wt-grid', tabIds: ['tab-new'] }
      })
    )
    expectNoSplitSurfacing()
    expect(replyTerminalCreate).toHaveBeenCalledTimes(2)
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-grid-disposed',
      error: 'Terminal creation was cancelled while the renderer was shutting down'
    })
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-request-grid-disposed',
      error: 'Terminal creation was cancelled while the renderer was shutting down'
    })
    expect(unsubscribeCreateTerminal).toHaveBeenCalledOnce()
    expect(unsubscribeStore).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    unregisterAfterDisposal()
    unregisterRequestGridAfterDisposal()
    vi.useRealTimers()
  })
})

describe('useIpcEvents browser tab close routing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    // Undo a partial mock of this module leaked by an earlier describe so the real
    // resolveFloatingWorkspaceBrowserWorkspaceId (source validation) is used here.
    vi.doUnmock('@/lib/floating-workspace-terminal-actions')
    closeTerminalTabMock.mockReset()
  })

  type RequestTabCloseListener = (data: {
    requestId: string
    tabId: string | null
    worktreeId?: string
  }) => void
  type CloseActiveTabListener = () => void
  type CloseFloatingItemListener = (payload: { sourceId: string }) => void
  type SelectFloatingIndexListener = (payload: { index: number }) => void
  type CloseTerminalListener = (data: { tabId: string; paneRuntimeId?: number | null }) => void
  type CloseSessionTabListener = (data: { tabId: string; worktreeId: string }) => void
  type TerminalTabCloseRequestListener = (data: { requestId: string; tabId: string }) => void

  async function useIpcEventsForCloseRouting({
    closeActiveTabListenerRef,
    closeFloatingItemListenerRef,
    selectFloatingIndexListenerRef,
    closeSessionTabListenerRef,
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

    // The CLI/RPC caller is answered immediately, so this close must never raise a modal.
    expect(closeTerminalTabMock).toHaveBeenCalledWith('terminal-1', {
      skipRunningProcessConfirm: true
    })
  })

  it('acknowledges whole-tab close only after the fresh session is durably persisted', async () => {
    const listenerRef: { current: TerminalTabCloseRequestListener | null } = { current: null }
    let finishPersist!: () => void
    const persistWorkspaceSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPersist = resolve
        })
    )
    const respondTerminalTabClose = vi.fn()
    closeTerminalTabMock.mockImplementation((_tabId: string, options: { onClosed?: () => void }) =>
      options.onClosed?.()
    )
    await useIpcEventsForCloseRouting({
      getState: () => ({}),
      terminalTabCloseRequestListenerRef: listenerRef,
      respondTerminalTabClose,
      persistWorkspaceSession
    })

    listenerRef.current?.({ requestId: 'close-1', tabId: 'terminal-1' })
    await Promise.resolve()

    expect(closeTerminalTabMock).toHaveBeenCalledWith(
      'terminal-1',
      expect.objectContaining({ rejectPinned: true })
    )
    expect(persistWorkspaceSession).toHaveBeenCalledTimes(1)
    expect(respondTerminalTabClose).not.toHaveBeenCalled()

    finishPersist()
    await vi.waitFor(() =>
      expect(respondTerminalTabClose).toHaveBeenCalledWith({ requestId: 'close-1' })
    )
  })

  it('rejects a pinned whole-tab close without persisting or reporting success', async () => {
    const listenerRef: { current: TerminalTabCloseRequestListener | null } = { current: null }
    const persistWorkspaceSession = vi.fn().mockResolvedValue(undefined)
    const respondTerminalTabClose = vi.fn()
    closeTerminalTabMock.mockImplementation((_tabId: string, options: { onCancel?: () => void }) =>
      options.onCancel?.()
    )
    await useIpcEventsForCloseRouting({
      getState: () => ({}),
      terminalTabCloseRequestListenerRef: listenerRef,
      respondTerminalTabClose,
      persistWorkspaceSession
    })

    listenerRef.current?.({ requestId: 'close-pinned', tabId: 'terminal-pinned' })

    expect(persistWorkspaceSession).not.toHaveBeenCalled()
    expect(respondTerminalTabClose).toHaveBeenCalledWith({
      requestId: 'close-pinned',
      error: 'terminal_tab_pinned'
    })
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

  // The floating-guest close receiver validates the source id still names a live floating
  // browser tab, then re-dispatches a typed window event for the mounted panel.
  function dispatchedEventTypes(): string[] {
    const dispatchEvent = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls
    return dispatchEvent.map((call) => (call[0] as Event).type)
  }

  // Main forwards the guest's page id, so the receiver must resolve it to the owning workspace id.
  it('re-dispatches a floating-guest close for a live floating browser page source', async () => {
    const closeFloatingItemListenerRef: { current: CloseFloatingItemListener | null } = {
      current: null
    }

    await useIpcEventsForCloseRouting({
      closeFloatingItemListenerRef,
      getState: () => ({
        browserTabsByWorktree: { 'global-floating-terminal': [{ id: 'workspace-1' }] },
        browserPagesByWorkspace: { 'workspace-1': [{ id: 'page-1' }] }
      })
    })

    closeFloatingItemListenerRef.current?.({ sourceId: 'page-1' })

    const closeEvents = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as CustomEvent)
      .filter((event) => event.type === FLOATING_WORKSPACE_GUEST_CLOSE_EVENT)
    expect(closeEvents).toHaveLength(1)
    expect(closeEvents[0].detail).toEqual({ sourceId: 'workspace-1' })
  })

  it('re-dispatches a floating-guest close for a live floating browser workspace source', async () => {
    const closeFloatingItemListenerRef: { current: CloseFloatingItemListener | null } = {
      current: null
    }

    await useIpcEventsForCloseRouting({
      closeFloatingItemListenerRef,
      getState: () => ({
        browserTabsByWorktree: { 'global-floating-terminal': [{ id: 'workspace-1' }] },
        browserPagesByWorkspace: { 'workspace-1': [{ id: 'page-1' }] }
      })
    })

    closeFloatingItemListenerRef.current?.({ sourceId: 'workspace-1' })

    const closeEvents = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as CustomEvent)
      .filter((event) => event.type === FLOATING_WORKSPACE_GUEST_CLOSE_EVENT)
    expect(closeEvents).toHaveLength(1)
    expect(closeEvents[0].detail).toEqual({ sourceId: 'workspace-1' })
  })

  it('ignores a floating-guest close for a stale/unknown source (no-op)', async () => {
    const closeFloatingItemListenerRef: { current: CloseFloatingItemListener | null } = {
      current: null
    }

    await useIpcEventsForCloseRouting({
      closeFloatingItemListenerRef,
      getState: () => ({
        browserTabsByWorktree: { 'global-floating-terminal': [{ id: 'workspace-1' }] },
        browserPagesByWorkspace: { 'workspace-1': [{ id: 'page-1' }] }
      })
    })

    closeFloatingItemListenerRef.current?.({ sourceId: 'already-closed' })

    expect(dispatchedEventTypes()).not.toContain(FLOATING_WORKSPACE_GUEST_CLOSE_EVENT)
  })

  it('re-dispatches a floating-guest index select', async () => {
    const selectFloatingIndexListenerRef: { current: SelectFloatingIndexListener | null } = {
      current: null
    }

    await useIpcEventsForCloseRouting({
      selectFloatingIndexListenerRef,
      getState: () => ({})
    })

    selectFloatingIndexListenerRef.current?.({ index: 2 })

    const selectEvents = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as CustomEvent)
      .filter((event) => event.type === FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT)
    expect(selectEvents).toHaveLength(1)
    expect(selectEvents[0].detail).toEqual({ index: 2 })
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
    sessionBoundary?: boolean
    terminalHandle?: string
    launchToken?: string
    providerSession?: { key: 'session_id'; id: string }
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
  type StoreSubscribeListener = (state: StoreLike, previousState: StoreLike) => void
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
      clearTransientAgentStatuses: vi.fn(),
      getAgentLaunchConfigForStatusMetadata: vi.fn(() => undefined),
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
    onClear?: (cb: (data: AgentStatusClearIpcPayload) => void) => () => void
    onLegacyWorkerTerminalRecovery?: (
      cb: (data: { paneKey: string; resolution: 'adopted' | 'exited' }) => void
    ) => () => void
    getSnapshot?: () => Promise<AgentStatusSetData[]>
    drop?: (paneKey: string) => void
    remoteWorkspace?: Record<string, unknown>
    runtime?: Record<string, unknown>
    ssh?: Record<string, unknown>
    ui?: Record<string, unknown>
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
          set: vi.fn(),
          ...args.ui
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
          onDetectedPortsChanged: () => () => {},
          ...args.ssh
        },
        agentStatus: {
          onSet: args.onSet,
          onClear: args.onClear ?? vi.fn(() => () => {}),
          onLegacyWorkerTerminalRecovery:
            args.onLegacyWorkerTerminalRecovery ?? vi.fn(() => () => {}),
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

  function buildSshAuthorityReconciliationHarness(args: {
    partialAuthority: { providerEpoch?: string; connectionGeneration?: number }
    latestAuthority: { providerEpoch: string; connectionGeneration: number }
  }): {
    emitPartialState: () => void
    getState: ReturnType<typeof vi.fn>
    requestReconnect: ReturnType<typeof vi.fn>
    setSshConnectionState: ReturnType<typeof vi.fn>
    storedState: () => Record<string, unknown> | undefined
  } {
    const targetId = 'target-reconciliation'
    const baseState = {
      targetId,
      status: 'connected' as const,
      error: null,
      reconnectAttempt: 0
    }
    const partialState = { ...baseState, ...args.partialAuthority }
    const latestState = { ...baseState, ...args.latestAuthority }
    const sshConnectionStates = new Map<string, Record<string, unknown>>()
    let sshStateListener: ((data: { targetId: string; state: unknown }) => void) | undefined
    const getState = vi.fn(() => Promise.resolve(latestState))
    const requestReconnect = vi.fn(async () => ({ status: 'complete' }))
    const setSshConnectionState = vi.fn((nextTargetId: string, state: Record<string, unknown>) => {
      sshConnectionStates.set(nextTargetId, state)
    })
    const storeState = buildStoreState({
      sshTargetLabels: new Map([[targetId, 'Reconciliation Target']]),
      sshConnectionStates,
      setSshConnectionState,
      invalidateStaleDirectSshTargetPtyBindings: vi.fn(() => 0),
      retryDirectSshTargetPanes: vi.fn(() => 0),
      setSshTargetsMetadata: vi.fn(),
      setRemovedSshTargetLabels: vi.fn(),
      setRemoteWorkspaceSyncStatus: vi.fn(),
      clearRemoteDetectedAgents: vi.fn(),
      clearDirectSshTargetPtyBindings: vi.fn(),
      clearRemovedSshTargetState: vi.fn()
    })
    const coordinator = {
      requestReconnect,
      replaceAuthority: vi.fn(),
      prepareOnly: vi.fn(),
      correctUnboundTerminals: vi.fn(() => 0),
      finalizeHydratedTerminals: vi.fn(() => 0),
      invalidate: vi.fn(),
      stop: vi.fn()
    }

    stubReactSyncEffect()
    stubAuxiliaryModules()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    vi.doMock('./direct-ssh-reconnect-rollout', () => ({
      isDirectSshReconnectCoordinatorRoutingEnabled: () => true
    }))
    vi.doMock('./direct-ssh-worktree-refresh-scheduler', () => ({
      createDirectSshWorktreeRefreshScheduler: () => ({
        stop: vi.fn(),
        disposeProvider: vi.fn()
      })
    }))
    vi.doMock('./direct-ssh-host-hydration', () => ({
      createDirectSshHostHydration: () => ({
        capturePreparationInput: vi.fn(),
        readHostScopedLineage: vi.fn(),
        isPreparationTokenCurrent: vi.fn(() => true),
        stop: vi.fn()
      })
    }))
    vi.doMock('./direct-ssh-reconnect-coordinator', () => ({
      createDirectSshReconnectCoordinator: () => coordinator
    }))
    vi.doMock('@/lib/direct-ssh-reconnect-product-telemetry', () => ({
      createDirectSshReconnectProductTelemetryAdapter: vi.fn()
    }))
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: () => () => {},
        ssh: {
          getState,
          onStateChanged: (listener: (data: { targetId: string; state: unknown }) => void) => {
            sshStateListener = listener
            return () => {}
          }
        }
      })
    )

    return {
      emitPartialState: () => {
        if (!sshStateListener) {
          throw new Error('Expected SSH state listener')
        }
        sshStateListener({ targetId, state: partialState })
      },
      getState,
      requestReconnect,
      setSshConnectionState,
      storedState: () => sshConnectionStates.get(targetId)
    }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('retires the exact sleeping record after adopted or exited legacy worker recovery', async () => {
    const clearSleepingAgentSession = vi.fn()
    const setSleepingAgentAutomaticResumeBlocked = vi.fn()
    let listener:
      | ((data: { paneKey: string; resolution: 'adopted' | 'exited' }) => void)
      | undefined
    const storeState = buildStoreState({
      clearSleepingAgentSession,
      setSleepingAgentAutomaticResumeBlocked
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
        onLegacyWorkerTerminalRecovery: (callback) => {
          listener = callback
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()
    expect(listener).toBeTypeOf('function')

    listener?.({ paneKey: 'tab-adopted:leaf-adopted', resolution: 'adopted' })
    expect(clearSleepingAgentSession).toHaveBeenCalledWith('tab-adopted:leaf-adopted')
    expect(setSleepingAgentAutomaticResumeBlocked).not.toHaveBeenCalled()

    clearSleepingAgentSession.mockClear()
    listener?.({ paneKey: 'tab-exited:leaf-exited', resolution: 'exited' })
    expect(clearSleepingAgentSession).toHaveBeenCalledWith('tab-exited:leaf-exited')
    expect(setSleepingAgentAutomaticResumeBlocked).not.toHaveBeenCalled()
  })

  it.each([
    { partialAuthority: { providerEpoch: 'epoch-current' } },
    { partialAuthority: { connectionGeneration: 7 } }
  ])(
    'fills a same-watermark partial SSH authority and routes it once',
    async ({ partialAuthority }) => {
      const harness = buildSshAuthorityReconciliationHarness({
        partialAuthority,
        latestAuthority: {
          providerEpoch: 'epoch-current',
          connectionGeneration: 7
        }
      })
      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()

      harness.emitPartialState()

      await vi.waitFor(() => {
        expect(harness.requestReconnect).toHaveBeenCalledOnce()
      })
      expect(harness.getState).toHaveBeenCalledOnce()
      expect(harness.setSshConnectionState).toHaveBeenCalledTimes(2)
      expect(harness.storedState()).toEqual({
        targetId: 'target-reconciliation',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        providerEpoch: 'epoch-current',
        connectionGeneration: 7
      })
    }
  )

  it.each([
    { partialAuthority: { providerEpoch: 'epoch-conflict' } },
    { partialAuthority: { connectionGeneration: 6 } }
  ])(
    'rejects a reconciliation reply that conflicts with present authority',
    async ({ partialAuthority }) => {
      const harness = buildSshAuthorityReconciliationHarness({
        partialAuthority,
        latestAuthority: {
          providerEpoch: 'epoch-current',
          connectionGeneration: 7
        }
      })
      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()

      harness.emitPartialState()

      await vi.waitFor(() => {
        expect(harness.getState).toHaveBeenCalledOnce()
      })
      await Promise.resolve()
      expect(harness.requestReconnect).not.toHaveBeenCalled()
      expect(harness.setSshConnectionState).toHaveBeenCalledOnce()
      expect(harness.storedState()).toEqual(
        expect.objectContaining({
          targetId: 'target-reconciliation',
          ...partialAuthority
        })
      )
    }
  )

  it.each([
    { enabled: true, expectedRoute: ['request'] },
    {
      enabled: false,
      expectedRoute: ['replace', 'invalidate', 'retry', 'capture', 'prepare']
    }
  ])(
    'routes a changed direct SSH authority through the enabled=$enabled path',
    async ({ enabled, expectedRoute }) => {
      const order: string[] = []
      let sshStateListener: ((data: { targetId: string; state: unknown }) => void) | undefined
      const oldState = {
        targetId: 'target-a',
        status: 'connected' as const,
        error: null,
        reconnectAttempt: 0,
        providerEpoch: 'epoch-old',
        connectionGeneration: 1
      }
      const nextState = {
        ...oldState,
        providerEpoch: 'epoch-new',
        connectionGeneration: 2
      }
      const storeState = buildStoreState({
        sshTargetLabels: new Map([['target-a', 'Target A']]),
        sshConnectionStates: new Map([['target-a', oldState]]),
        setSshConnectionState: (targetId: string, state: unknown) => {
          ;(storeState.sshConnectionStates as Map<string, unknown>).set(targetId, state)
        },
        invalidateStaleDirectSshTargetPtyBindings: () => {
          order.push('invalidate')
          return 1
        },
        retryDirectSshTargetPanes: () => {
          order.push('retry')
          return 1
        },
        setSshTargetsMetadata: vi.fn(),
        setRemovedSshTargetLabels: vi.fn(),
        setRemoteWorkspaceSyncStatus: vi.fn(),
        clearRemoteDetectedAgents: vi.fn(),
        clearDirectSshTargetPtyBindings: vi.fn(),
        clearRemovedSshTargetState: vi.fn()
      })
      const coordinator = {
        requestReconnect: vi.fn(async () => {
          order.push('request')
          return { status: 'complete' }
        }),
        replaceAuthority: vi.fn(() => {
          order.push('replace')
        }),
        prepareOnly: vi.fn(async () => {
          order.push('prepare')
          return { token: null }
        }),
        correctUnboundTerminals: vi.fn(() => 0),
        finalizeHydratedTerminals: vi.fn(() => 0),
        invalidate: vi.fn(),
        stop: vi.fn()
      }
      const capturePreparationInput = vi.fn(async (authority, reason) => {
        order.push('capture')
        return {
          ...authority,
          reason,
          catalogRevision: 1,
          repoRefs: [],
          authorityRequirement: 'required'
        }
      })

      stubReactSyncEffect()
      stubAuxiliaryModules()
      vi.doMock('../store', () => ({
        useAppStore: {
          subscribe: vi.fn(() => () => {}),
          getState: () => storeState
        }
      }))
      vi.doMock('./direct-ssh-reconnect-rollout', () => ({
        isDirectSshReconnectCoordinatorRoutingEnabled: () => enabled
      }))
      vi.doMock('./direct-ssh-worktree-refresh-scheduler', () => ({
        createDirectSshWorktreeRefreshScheduler: () => ({
          stop: vi.fn(),
          disposeProvider: vi.fn()
        })
      }))
      vi.doMock('./direct-ssh-host-hydration', () => ({
        createDirectSshHostHydration: () => ({
          capturePreparationInput,
          readHostScopedLineage: vi.fn(),
          isPreparationTokenCurrent: vi.fn(() => true),
          stop: vi.fn()
        })
      }))
      vi.doMock('./direct-ssh-reconnect-coordinator', () => ({
        createDirectSshReconnectCoordinator: () => coordinator
      }))
      vi.doMock('@/lib/direct-ssh-reconnect-product-telemetry', () => ({
        createDirectSshReconnectProductTelemetryAdapter: vi.fn()
      }))
      vi.stubGlobal(
        'window',
        buildWindowApi({
          onSet: () => () => {},
          ssh: {
            onStateChanged: (listener: (data: { targetId: string; state: unknown }) => void) => {
              sshStateListener = listener
              return () => {}
            }
          }
        })
      )

      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()
      sshStateListener?.({ targetId: 'target-a', state: nextState })
      await Promise.resolve()
      await Promise.resolve()

      expect(order).toEqual(expectedRoute)
      if (enabled) {
        expect(coordinator.requestReconnect).toHaveBeenCalledOnce()
        expect(coordinator.prepareOnly).not.toHaveBeenCalled()
      } else {
        expect(coordinator.requestReconnect).not.toHaveBeenCalled()
        expect(coordinator.replaceAuthority).toHaveBeenCalledOnce()
        expect(coordinator.prepareOnly).toHaveBeenCalledOnce()
      }
    }
  )

  it('does not let initial SSH port snapshots overwrite newer push events', async () => {
    const targetId = 'target-ports'
    const secondTargetId = 'target-ports-second'
    const rejectingTargetId = 'target-ports-rejecting'
    const partialTargetId = 'target-ports-partial'
    const connectedState = {
      targetId,
      status: 'connected' as const,
      error: null,
      reconnectAttempt: 0,
      providerEpoch: 'epoch-ports',
      connectionGeneration: 3
    }
    const secondConnectedState = {
      ...connectedState,
      targetId: secondTargetId,
      providerEpoch: 'epoch-ports-second'
    }
    const rejectingConnectedState = {
      ...connectedState,
      targetId: rejectingTargetId,
      providerEpoch: 'epoch-ports-rejecting'
    }
    const partialConnectedState = {
      ...connectedState,
      targetId: partialTargetId,
      providerEpoch: null,
      connectionGeneration: undefined
    }
    const reconciledPartialState = {
      ...connectedState,
      targetId: partialTargetId,
      providerEpoch: 'epoch-ports-partial',
      connectionGeneration: 4
    }
    const liveForward = {
      id: 'forward-live',
      targetId,
      localPort: 17860,
      remoteHost: '127.0.0.1',
      remotePort: 7860,
      status: 'active' as const
    }
    const secondForward = {
      ...liveForward,
      id: 'forward-second',
      targetId: secondTargetId,
      localPort: 17861,
      remotePort: 7861
    }
    const rejectingTargetForward = {
      ...liveForward,
      id: 'forward-rejecting-target',
      targetId: rejectingTargetId,
      localPort: 17862,
      remotePort: 7862
    }
    const partialTargetForward = {
      ...liveForward,
      id: 'forward-partial-target',
      targetId: partialTargetId,
      localPort: 17863,
      remotePort: 7863
    }
    const detectedPort = {
      port: 7860,
      pid: 42,
      processName: 'python',
      command: 'python -m http.server 7860'
    }
    const secondDetectedPort = {
      ...detectedPort,
      port: 7861,
      pid: 43,
      command: 'python -m http.server 7861'
    }
    let resolveForwards: (value: []) => void = () => {}
    let resolveDetected: (value: (typeof detectedPort)[]) => void = () => {}
    let resolveSecondForwards: (value: (typeof secondForward)[]) => void = () => {}
    let resolveSecondDetected: (value: []) => void = () => {}
    const forwardsSnapshot = new Promise<[]>((resolve) => {
      resolveForwards = resolve
    })
    const detectedSnapshot = new Promise<(typeof detectedPort)[]>((resolve) => {
      resolveDetected = resolve
    })
    const secondForwardsSnapshot = new Promise<(typeof secondForward)[]>((resolve) => {
      resolveSecondForwards = resolve
    })
    const secondDetectedSnapshot = new Promise<[]>((resolve) => {
      resolveSecondDetected = resolve
    })
    const listPortForwards = vi.fn(({ targetId: requestedTargetId }: { targetId: string }) => {
      if (requestedTargetId === rejectingTargetId) {
        return Promise.resolve([rejectingTargetForward])
      }
      if (requestedTargetId === partialTargetId) {
        return Promise.resolve([partialTargetForward])
      }
      return requestedTargetId === targetId ? forwardsSnapshot : secondForwardsSnapshot
    })
    const listDetectedPorts = vi.fn(({ targetId: requestedTargetId }: { targetId: string }) => {
      if (requestedTargetId === rejectingTargetId) {
        return Promise.reject(new Error('detected snapshot unavailable'))
      }
      if (requestedTargetId === partialTargetId) {
        return Promise.resolve([])
      }
      return requestedTargetId === targetId ? detectedSnapshot : secondDetectedSnapshot
    })
    let forwardListener:
      | ((data: { targetId: string; forwards: (typeof liveForward)[] }) => void)
      | undefined
    let detectedListener:
      | ((data: { targetId: string; ports: (typeof detectedPort)[] }) => void)
      | undefined
    const setPortForwards = vi.fn()
    const setDetectedPorts = vi.fn()
    const sshConnectionStates = new Map<
      string,
      | typeof connectedState
      | typeof secondConnectedState
      | typeof rejectingConnectedState
      | typeof partialConnectedState
      | typeof reconciledPartialState
    >()
    const storeState = buildStoreState({
      sshTargetLabels: new Map([
        [targetId, 'Ports Target'],
        [secondTargetId, 'Second Ports Target'],
        [rejectingTargetId, 'Rejecting Ports Target'],
        [partialTargetId, 'Partial Ports Target']
      ]),
      sshConnectionStates,
      setSshConnectionState: (
        nextTargetId: string,
        state:
          | typeof connectedState
          | typeof secondConnectedState
          | typeof rejectingConnectedState
          | typeof partialConnectedState
          | typeof reconciledPartialState
      ) => {
        sshConnectionStates.set(nextTargetId, state)
      },
      setPortForwards,
      setDetectedPorts,
      setSshTargetsMetadata: vi.fn(),
      setRemovedSshTargetLabels: vi.fn(),
      setRemoteWorkspaceSyncStatus: vi.fn(),
      fetchRuntimeEnvironmentRepos: vi.fn(async () => []),
      fetchWorktreeLineage: vi.fn(async () => undefined),
      clearRemoteDetectedAgents: vi.fn(),
      clearDirectSshTargetPtyBindings: vi.fn(),
      clearRemovedSshTargetState: vi.fn(),
      invalidateStaleDirectSshTargetPtyBindings: vi.fn(() => 0),
      retryDirectSshTargetPanes: vi.fn(() => 0)
    })
    const coordinator = {
      requestReconnect: vi.fn(async () => ({ status: 'complete' })),
      replaceAuthority: vi.fn(),
      prepareOnly: vi.fn(async () => ({ token: null })),
      correctUnboundTerminals: vi.fn(() => 0),
      finalizeHydratedTerminals: vi.fn(() => 0),
      invalidate: vi.fn(),
      stop: vi.fn()
    }
    let partialTargetStateCalls = 0

    stubReactSyncEffect()
    stubAuxiliaryModules()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    vi.doMock('./direct-ssh-reconnect-rollout', () => ({
      isDirectSshReconnectCoordinatorRoutingEnabled: () => true
    }))
    vi.doMock('./direct-ssh-worktree-refresh-scheduler', () => ({
      createDirectSshWorktreeRefreshScheduler: () => ({
        stop: vi.fn(),
        disposeProvider: vi.fn()
      })
    }))
    vi.doMock('./direct-ssh-host-hydration', () => ({
      createDirectSshHostHydration: () => ({
        capturePreparationInput: vi.fn(),
        readHostScopedLineage: vi.fn(),
        isPreparationTokenCurrent: vi.fn(() => true),
        stop: vi.fn()
      })
    }))
    vi.doMock('./direct-ssh-reconnect-coordinator', () => ({
      createDirectSshReconnectCoordinator: () => coordinator
    }))
    vi.doMock('@/lib/direct-ssh-reconnect-product-telemetry', () => ({
      createDirectSshReconnectProductTelemetryAdapter: vi.fn()
    }))
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: () => () => {},
        ssh: {
          listTargets: () =>
            Promise.resolve([
              { id: rejectingTargetId, label: 'Rejecting Ports Target' },
              { id: partialTargetId, label: 'Partial Ports Target' },
              { id: targetId, label: 'Ports Target' },
              { id: secondTargetId, label: 'Second Ports Target' }
            ]),
          listRemovedTargetLabels: () => Promise.resolve({}),
          getState: ({ targetId: requestedTargetId }: { targetId: string }) => {
            if (requestedTargetId === partialTargetId) {
              partialTargetStateCalls += 1
              return Promise.resolve(
                partialTargetStateCalls === 1 ? partialConnectedState : reconciledPartialState
              )
            }
            return Promise.resolve(
              requestedTargetId === rejectingTargetId
                ? rejectingConnectedState
                : requestedTargetId === targetId
                  ? connectedState
                  : secondConnectedState
            )
          },
          listPortForwards,
          listDetectedPorts,
          onPortForwardsChanged: (
            listener: (data: { targetId: string; forwards: (typeof liveForward)[] }) => void
          ) => {
            forwardListener = listener
            return () => {}
          },
          onDetectedPortsChanged: (
            listener: (data: { targetId: string; ports: (typeof detectedPort)[] }) => void
          ) => {
            detectedListener = listener
            return () => {}
          }
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    await vi.waitFor(() => {
      expect(forwardListener).toBeTypeOf('function')
      expect(detectedListener).toBeTypeOf('function')
      expect(partialTargetStateCalls).toBe(2)
      expect(sshConnectionStates.get(partialTargetId)).toEqual(reconciledPartialState)
      expect(listPortForwards).toHaveBeenCalledTimes(4)
      expect(listDetectedPorts).toHaveBeenCalledTimes(4)
      expect(
        setPortForwards.mock.calls.filter(
          ([requestedTargetId]) => requestedTargetId === rejectingTargetId
        )
      ).toEqual([[rejectingTargetId, [rejectingTargetForward]]])
      expect(
        setPortForwards.mock.calls.filter(
          ([requestedTargetId]) => requestedTargetId === partialTargetId
        )
      ).toEqual([[partialTargetId, [partialTargetForward]]])
    })
    forwardListener?.({ targetId, forwards: [liveForward] })
    resolveForwards([])
    resolveDetected([detectedPort])

    await vi.waitFor(() => {
      expect(
        setPortForwards.mock.calls.filter(([requestedTargetId]) => requestedTargetId === targetId)
      ).toEqual([[targetId, [liveForward]]])
      expect(
        setDetectedPorts.mock.calls.filter(([requestedTargetId]) => requestedTargetId === targetId)
      ).toEqual([[targetId, [detectedPort]]])
      expect(listPortForwards).toHaveBeenCalledTimes(4)
      expect(listDetectedPorts).toHaveBeenCalledTimes(4)
    })
    forwardListener?.({ targetId, forwards: [liveForward] })
    detectedListener?.({ targetId: secondTargetId, ports: [secondDetectedPort] })
    resolveSecondForwards([secondForward])
    resolveSecondDetected([])

    await vi.waitFor(() => {
      expect(
        setPortForwards.mock.calls.filter(
          ([requestedTargetId]) => requestedTargetId === secondTargetId
        )
      ).toEqual([[secondTargetId, [secondForward]]])
      expect(
        setDetectedPorts.mock.calls.filter(
          ([requestedTargetId]) => requestedTargetId === secondTargetId
        )
      ).toEqual([[secondTargetId, [secondDetectedPort]]])
    })
  describe('delayed orchestration-grid split lifecycle', () => {
    const GRID_TAB_ID = 'tab-grid-lifecycle'
    const GRID_WORKTREE_ID = 'wt-grid-lifecycle'
    const GRID_LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    const GRID_LEAF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
    const GRID_LEAF_C = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
    const GRID_LEAF_D = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4'
    const GRID_LEAF_E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5'
    const GRID_LEAF_F = 'ffffffff-ffff-4fff-8fff-fffffffffff6'
    const GRID_LEAF_G = '11111111-2222-4333-8444-555555555557'
    const GRID_LEAF_H = '22222222-3333-4444-8555-666666666668'

    type GridCreateTerminalData = {
      requestId: string
      worktreeId: string
      command?: string
      env?: Record<string, string>
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      title: string
      ptyId: string
      presentation: 'background' | 'focused'
      tabId: string
      leafId: string
      splitFromLeafId: string
      splitSourceLeafIds: string[]
      splitDirection: 'horizontal' | 'vertical'
      placement: 'orchestration-grid'
    }

    type GridRequestTerminalCreateData = {
      requestId: string
      worktreeId: string
      command?: string
      env?: Record<string, string>
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      title: string
      presentation: 'background' | 'focused'
      placement: 'orchestration-grid'
    }

    type GridFailureStep =
      | 'activation'
      | 'sidebar'
      | 'binding'
      | 'layout'
      | 'dispatch'
      | 'duplicate-leaf'
      | 'invalid-source'
      | 'listener-absent'
      | 'listener-throw'
      | 'manager-absent'
      | 'partial-create'
      | 'rollback-cleanup'
      | 'split-null'
      | 'wrong-tab'
      | 'runtime-focus'
      | 'tab-focus'

    type SplitEvent = CustomEvent<{
      tabId: string
      direction: 'horizontal' | 'vertical'
      sourceLeafId?: string
      sourceLeafIds?: string[]
      sourcePtyId?: string
      newLeafId?: string
      ptyId?: string
      startup?: { command: string; launchConfig?: SleepingAgentLaunchConfig }
      activate?: boolean
      acknowledge?: (result: {
        status: 'success'
        rollback: () => void
        afterCommit?: () => void
      }) => void
    }>

    type GridLifecycleHarness = {
      createTerminal: (data: GridCreateTerminalData) => void
      requestTerminalCreate: (data: GridRequestTerminalCreateData) => void
      registerConsumer: () => () => void
      replyTerminalCreate: ReturnType<typeof vi.fn>
      dispatchEvent: ReturnType<typeof vi.fn>
      focusRuntimeTerminalSurface: ReturnType<typeof vi.fn>
      focusTerminalTabSurface: ReturnType<typeof vi.fn>
      getState: () => StoreLike
      setActiveGridLeaf: (leafId: string) => void
      setGridLayout: (layout: TerminalLayoutSnapshot) => void
      setFailureStep: (step: GridFailureStep | null) => void
      getOrphanResourceCount: () => number
      getRollbackCount: () => number
      setActiveWorktree: ReturnType<typeof vi.fn>
      markWorktreeVisited: ReturnType<typeof vi.fn>
      revealWorktreeInSidebar: ReturnType<typeof vi.fn>
      updateTabPtyId: ReturnType<typeof vi.fn>
      dispose: () => void
    }

    function initialGridLayout(): TerminalLayoutSnapshot {
      return {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: GRID_LEAF_A },
          second: { type: 'leaf', leafId: GRID_LEAF_B },
          ratio: 0.5
        },
        activeLeafId: GRID_LEAF_A,
        expandedLeafId: null,
        layoutMode: 'orchestration-grid',
        ptyIdsByLeafId: { [GRID_LEAF_A]: 'pty-grid-a', [GRID_LEAF_B]: 'pty-grid-b' },
        titlesByLeafId: { [GRID_LEAF_A]: 'Worker A', [GRID_LEAF_B]: 'Worker B' }
      }
    }

    function fullGridRowLayout(): TerminalLayoutSnapshot {
      const leaves: readonly (readonly [string, string, string])[] = [
        [GRID_LEAF_A, 'pty-grid-a', 'Worker A'],
        [GRID_LEAF_B, 'pty-grid-b', 'Worker B'],
        [GRID_LEAF_E, 'pty-grid-e', 'Worker E'],
        [GRID_LEAF_F, 'pty-grid-f', 'Worker F'],
        [GRID_LEAF_G, 'pty-grid-g', 'Worker G'],
        [GRID_LEAF_H, 'pty-grid-h', 'Worker H']
      ]
      const leafIds = leaves.map(([leafId]) => leafId)
      return {
        root: buildOrchestrationTerminalGridRoot(leafIds),
        activeLeafId: GRID_LEAF_A,
        expandedLeafId: null,
        layoutMode: 'orchestration-grid',
        ptyIdsByLeafId: Object.fromEntries(leaves.map(([leafId, ptyId]) => [leafId, ptyId])),
        titlesByLeafId: Object.fromEntries(leaves.map(([leafId, , title]) => [leafId, title]))
      }
    }

    async function setupGridLifecycleHarness(): Promise<GridLifecycleHarness> {
      let state: StoreLike
      let failureStep: GridFailureStep | null = null
      let disposeEffect = (): void => undefined
      const createTerminalListenerRef: {
        current: ((data: GridCreateTerminalData) => void) | null
      } = { current: null }
      const requestTerminalCreateListenerRef: {
        current: ((data: GridRequestTerminalCreateData) => void) | null
      } = { current: null }
      const replyTerminalCreate = vi.fn()
      const splitEventTarget = new EventTarget()
      const emptySplitEventTarget = new EventTarget()
      const splitStartupDeps: {
        startup?: {
          command: string
          launchConfig?: SleepingAgentLaunchConfig
        } | null
      } = { startup: null }
      type GridManagerPane = { id: number; leafId: string }
      type GridManagerResource = {
        pane: GridManagerPane
        domNodes: number
        listeners: number
        parsers: number
        ptys: number
        timers: number
      }
      const managerPanes = new Map<number, GridManagerPane>()
      const managerPaneIdByLeafId = new Map<string, number>()
      const createdResources = new Map<number, GridManagerResource>()
      let nextManagerPaneId = 1
      let activeManagerPaneId: number | null = null
      let rollbackCount = 0

      const replaceState = (patch: StoreLike): void => {
        state = { ...state, ...patch }
      }
      const failAfterMutation = (step: GridFailureStep): void => {
        if (failureStep === step || (failureStep === 'rollback-cleanup' && step === 'layout')) {
          throw new Error(`${step} failed`)
        }
      }
      const setActiveView = vi.fn((activeView: string) => replaceState({ activeView }))
      const setActiveWorktree = vi.fn((activeWorktreeId: string) =>
        replaceState({ activeWorktreeId })
      )
      const markWorktreeVisited = vi.fn((worktreeId: string) => {
        replaceState({
          lastVisitedAtByWorktreeId: {
            ...(state.lastVisitedAtByWorktreeId as Record<string, number>),
            [worktreeId]: 2
          }
        })
        failAfterMutation('activation')
      })
      const recordWorktreeVisit = vi.fn((worktreeId: string) => {
        replaceState({
          worktreeNavHistory: [...((state.worktreeNavHistory as string[]) ?? []), worktreeId]
        })
      })
      const setActiveTabType = vi.fn((activeTabType: string) => replaceState({ activeTabType }))
      const setActiveTab = vi.fn((activeTabId: string) => replaceState({ activeTabId }))
      const revealWorktreeInSidebar = vi.fn((worktreeId: string) => {
        replaceState({ pendingRevealWorktree: { worktreeId, behavior: 'smooth' } })
        failAfterMutation('sidebar')
      })
      const updateTabPtyId = vi.fn((tabId: string, ptyId: string) => {
        const ptyIdsByTabId = state.ptyIdsByTabId as Record<string, string[]>
        const tabsByWorktree = state.tabsByWorktree as Record<
          string,
          { id: string; ptyId: string | null; title: string }[]
        >
        replaceState({
          ptyIdsByTabId: {
            ...ptyIdsByTabId,
            [tabId]: [...(ptyIdsByTabId[tabId] ?? []), ptyId]
          },
          tabsByWorktree: {
            ...tabsByWorktree,
            [GRID_WORKTREE_ID]: tabsByWorktree[GRID_WORKTREE_ID]!.map((tab) =>
              tab.id === tabId && tab.ptyId === null ? { ...tab, ptyId } : tab
            )
          }
        })
        failAfterMutation('binding')
      })
      const setTabLayout = vi.fn((tabId: string, layout: TerminalLayoutSnapshot) => {
        replaceState({
          terminalLayoutsByTabId: {
            ...(state.terminalLayoutsByTabId as Record<string, TerminalLayoutSnapshot>),
            [tabId]: layout
          }
        })
        failAfterMutation('layout')
      })
      const registerAgentLaunchConfig = vi.fn(
        (paneKey: string, launchConfig: SleepingAgentLaunchConfig) => {
          replaceState({
            agentLaunchConfigByPaneKey: {
              ...(state.agentLaunchConfigByPaneKey as Record<string, unknown>),
              [paneKey]: { launchConfig }
            }
          })
        }
      )
      const clearAgentLaunchConfig = vi.fn((paneKey: string) => {
        const next = { ...(state.agentLaunchConfigByPaneKey as Record<string, unknown>) }
        delete next[paneKey]
        replaceState({ agentLaunchConfigByPaneKey: next })
      })
      const seedManagerFromLayout = (layout: TerminalLayoutSnapshot): void => {
        managerPanes.clear()
        managerPaneIdByLeafId.clear()
        createdResources.clear()
        nextManagerPaneId = 1
        for (const leafId of collectTerminalLayoutLeafIds(layout.root)) {
          const pane = { id: nextManagerPaneId, leafId }
          nextManagerPaneId += 1
          managerPanes.set(pane.id, pane)
          managerPaneIdByLeafId.set(leafId, pane.id)
        }
        activeManagerPaneId = layout.activeLeafId
          ? (managerPaneIdByLeafId.get(layout.activeLeafId) ?? null)
          : null
      }
      const disposeCreatedResource = (paneId: number): void => {
        const resource = createdResources.get(paneId)
        if (!resource) {
          return
        }
        managerPanes.delete(paneId)
        managerPaneIdByLeafId.delete(resource.pane.leafId)
        createdResources.delete(paneId)
        clearAgentLaunchConfig(makePaneKey(GRID_TAB_ID, resource.pane.leafId))
      }
      const createManagerPane = (opts?: {
        activate?: boolean
        leafId?: string
        ptyId?: string
      }): GridManagerPane | null => {
        if (failureStep === 'split-null') {
          return null
        }
        const leafId = opts?.leafId
        if (!leafId) {
          throw new Error('manager received no leaf id')
        }
        const pane = { id: nextManagerPaneId, leafId }
        nextManagerPaneId += 1
        managerPanes.set(pane.id, pane)
        managerPaneIdByLeafId.set(leafId, pane.id)
        createdResources.set(pane.id, {
          pane,
          domNodes: 1,
          listeners: 1,
          parsers: 1,
          ptys: 1,
          timers: 1
        })
        if (splitStartupDeps.startup?.launchConfig) {
          registerAgentLaunchConfig(
            makePaneKey(GRID_TAB_ID, leafId),
            splitStartupDeps.startup.launchConfig
          )
        }
        if (opts.activate !== false) {
          activeManagerPaneId = pane.id
        }
        if (failureStep === 'partial-create') {
          // Mirrors PaneManager's low-level compensation before the listener
          // receives the thrown partial-creation failure.
          rollbackCount += 1
          disposeCreatedResource(pane.id)
          throw new Error('partial create failed')
        }
        return pane
      }
      const gridPaneManager = {
        getNumericIdForLeaf: vi.fn((leafId: string) => {
          if (failureStep === 'invalid-source' && leafId !== GRID_LEAF_C) {
            return null
          }
          if (failureStep === 'duplicate-leaf' && !managerPaneIdByLeafId.has(leafId)) {
            return managerPanes.keys().next().value ?? null
          }
          return managerPaneIdByLeafId.get(leafId) ?? null
        }),
        getPanes: vi.fn(() => [...managerPanes.values()]),
        getActivePane: vi.fn(() =>
          activeManagerPaneId === null ? null : (managerPanes.get(activeManagerPaneId) ?? null)
        ),
        splitPane: vi.fn(
          (
            _paneId: number,
            _direction: 'horizontal' | 'vertical',
            opts?: { activate?: boolean; leafId?: string; ptyId?: string }
          ) => createManagerPane(opts)
        ),
        splitPaneAroundLeafIds: vi.fn(
          (
            _sourceLeafIds: readonly string[],
            _paneId: number,
            _direction: 'horizontal' | 'vertical',
            opts?: { activate?: boolean; leafId?: string; ptyId?: string }
          ) => createManagerPane(opts)
        ),
        arrangeOrchestrationGrid: vi.fn(() => {
          if (failureStep === 'listener-throw') {
            throw new Error('listener failed')
          }
        }),
        setActivePane: vi.fn((paneId: number) => {
          if (managerPanes.has(paneId)) {
            activeManagerPaneId = paneId
          }
        }),
        closePane: vi.fn((paneId: number) => {
          rollbackCount += 1
          if (failureStep === 'rollback-cleanup' && rollbackCount === 1) {
            throw new Error('transient rollback cleanup failed')
          }
          disposeCreatedResource(paneId)
          if (activeManagerPaneId === paneId) {
            activeManagerPaneId = managerPanes.keys().next().value ?? null
          }
        })
      }
      const focusRuntimeTerminalSurface = vi.fn(() => {
        failAfterMutation('runtime-focus')
        return false
      })
      const focusTerminalTabSurface = vi.fn(() => {
        failAfterMutation('tab-focus')
      })
      const dispatchEvent = vi.fn((event: Event) => {
        if (event.type === 'orca-split-terminal-pane') {
          if (failureStep === 'listener-absent') {
            return emptySplitEventTarget.dispatchEvent(event)
          }
          if (failureStep === 'wrong-tab') {
            const detail = (event as SplitEvent).detail
            return splitEventTarget.dispatchEvent(
              new CustomEvent(event.type, {
                detail: { ...detail, tabId: 'tab-wrong-listener' }
              })
            )
          }
          failAfterMutation('dispatch')
          return splitEventTarget.dispatchEvent(event)
        }
        return true
      })

      state = buildStoreState({
        activeView: 'editor',
        activeWorktreeId: 'wt-before-grid',
        activeTabType: 'editor',
        activeTabId: 'tab-before-grid',
        activeTabIdByWorktree: { 'wt-before-grid': 'tab-before-grid' },
        isNavigatingHistory: false,
        lastVisitedAtByWorktreeId: { 'wt-before-grid': 1 },
        worktreeNavHistory: ['wt-before-grid'],
        pendingRevealWorktree: null,
        setActiveView,
        setActiveWorktree,
        markWorktreeVisited,
        recordWorktreeVisit,
        setActiveTabType,
        setActiveTab,
        revealWorktreeInSidebar,
        updateTabPtyId,
        setTabLayout,
        registerAgentLaunchConfig,
        clearAgentLaunchConfig,
        setTabCustomTitle: vi.fn(),
        queueTabStartupCommand: vi.fn(),
        createTab: vi.fn(() => {
          throw new Error('existing grid append must not create a tab')
        }),
        tabsByWorktree: {
          [GRID_WORKTREE_ID]: [{ id: GRID_TAB_ID, ptyId: null, title: 'Orchestration workers' }]
        },
        ptyIdsByTabId: { [GRID_TAB_ID]: ['pty-grid-a', 'pty-grid-b'] },
        terminalLayoutsByTabId: { [GRID_TAB_ID]: initialGridLayout() },
        agentLaunchConfigByPaneKey: {},
        folderWorkspaces: [],
        projectGroups: [],
        openFiles: [],
        browserTabsByWorktree: {},
        tabBarOrderByWorktree: {},
        unifiedTabsByWorktree: {},
        groupsByWorktree: {},
        settings: {
          terminalFontSize: 13,
          experimentalNativeChat: false,
          openAgentTabsInChatByDefault: false,
          activeRuntimeEnvironmentId: undefined
        }
      })
      seedManagerFromLayout(initialGridLayout())

      vi.doMock('react', async () => {
        const actual = await vi.importActual<typeof ReactModule>('react')
        return {
          ...actual,
          useEffect: (effect: () => void | (() => void)) => {
            disposeEffect = effect() ?? (() => undefined)
          }
        }
      })
      vi.doMock('../store', () => ({
        useAppStore: {
          subscribe: vi.fn(() => () => undefined),
          getState: () => state,
          setState: (next: StoreLike | ((current: StoreLike) => StoreLike), replace?: boolean) => {
            const nextState = typeof next === 'function' ? next(state) : next
            state = replace ? nextState : { ...state, ...nextState }
          }
        }
      }))
      stubAuxiliaryModules()
      vi.doMock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface }))
      vi.doMock('@/runtime/sync-runtime-graph', () => ({
        focusRuntimeTerminalSurface
      }))
      vi.doMock('@/lib/activate-tab-and-focus-pane', () => ({
        activateTabAndFocusPane: vi.fn()
      }))
      vi.stubGlobal('window', {
        ...buildWindowApi({
          onSet: () => () => undefined,
          ui: {
            onCreateTerminal: (listener: (data: GridCreateTerminalData) => void) => {
              createTerminalListenerRef.current = listener
              return () => undefined
            },
            onRequestTerminalCreate: (listener: (data: GridRequestTerminalCreateData) => void) => {
              requestTerminalCreateListenerRef.current = listener
              return () => undefined
            },
            replyTerminalCreate
          }
        }),
        dispatchEvent
      })

      const { createTerminalPaneSplitEventHandler } =
        await import('../components/terminal-pane/use-terminal-pane-lifecycle')
      splitEventTarget.addEventListener(
        'orca-split-terminal-pane',
        createTerminalPaneSplitEventHandler({
          tabId: GRID_TAB_ID,
          getManager: () => (failureStep === 'manager-absent' ? null : (gridPaneManager as never)),
          startupDeps: splitStartupDeps,
          recordSplit: () => true,
          consumeMirrorTelemetry: vi.fn(() => false)
        })
      )
      const { registerTerminalSurfaceActionConsumer, useIpcEvents: initializeIpcEvents } =
        await import('./useIpcEvents')
      initializeIpcEvents()
      await Promise.resolve()

      if (!createTerminalListenerRef.current || !requestTerminalCreateListenerRef.current) {
        throw new Error('Expected terminal lifecycle listeners to be registered')
      }
      const createTerminal = createTerminalListenerRef.current
      const requestTerminalCreate = requestTerminalCreateListenerRef.current

      return {
        createTerminal,
        requestTerminalCreate,
        registerConsumer: () => registerTerminalSurfaceActionConsumer(GRID_TAB_ID),
        replyTerminalCreate,
        dispatchEvent,
        focusRuntimeTerminalSurface,
        focusTerminalTabSurface,
        getState: () => state,
        setActiveGridLeaf: (leafId) => {
          const layouts = state.terminalLayoutsByTabId as Record<string, TerminalLayoutSnapshot>
          replaceState({
            terminalLayoutsByTabId: {
              ...layouts,
              [GRID_TAB_ID]: { ...layouts[GRID_TAB_ID]!, activeLeafId: leafId }
            }
          })
          activeManagerPaneId = managerPaneIdByLeafId.get(leafId) ?? activeManagerPaneId
        },
        setGridLayout: (layout) => {
          replaceState({
            terminalLayoutsByTabId: { [GRID_TAB_ID]: layout },
            ptyIdsByTabId: { [GRID_TAB_ID]: Object.values(layout.ptyIdsByLeafId ?? {}) }
          })
          seedManagerFromLayout(layout)
        },
        setFailureStep: (step) => {
          failureStep = step
        },
        getOrphanResourceCount: () =>
          [...createdResources.values()].reduce(
            (count, resource) =>
              count +
              resource.domNodes +
              resource.listeners +
              resource.parsers +
              resource.ptys +
              resource.timers,
            0
          ),
        getRollbackCount: () => rollbackCount,
        setActiveWorktree,
        markWorktreeVisited,
        revealWorktreeInSidebar,
        updateTabPtyId,
        dispose: () => disposeEffect()
      }
    }

    function splitEvents(harness: GridLifecycleHarness): SplitEvent[] {
      return harness.dispatchEvent.mock.calls
        .map(([event]) => event as Event)
        .filter((event) => event.type === 'orca-split-terminal-pane') as SplitEvent[]
    }

    function rendererStateSnapshot(harness: GridLifecycleHarness): unknown {
      const state = harness.getState()
      return structuredClone({
        activeView: state.activeView,
        activeWorktreeId: state.activeWorktreeId,
        activeTabType: state.activeTabType,
        activeTabId: state.activeTabId,
        lastVisitedAtByWorktreeId: state.lastVisitedAtByWorktreeId,
        worktreeNavHistory: state.worktreeNavHistory,
        pendingRevealWorktree: state.pendingRevealWorktree,
        tabsByWorktree: state.tabsByWorktree,
        ptyIdsByTabId: state.ptyIdsByTabId,
        terminalLayoutsByTabId: state.terminalLayoutsByTabId,
        agentLaunchConfigByPaneKey: state.agentLaunchConfigByPaneKey
      })
    }

    function queueFocusedPtyAppend(
      harness: GridLifecycleHarness,
      requestId = 'pty-transaction'
    ): void {
      harness.createTerminal({
        requestId,
        worktreeId: GRID_WORKTREE_ID,
        command: 'codex --transaction',
        launchConfig: { agentArgs: '--transaction', agentEnv: {} },
        launchAgent: 'codex',
        title: 'Worker C',
        ptyId: 'pty-grid-c',
        presentation: 'focused',
        tabId: GRID_TAB_ID,
        leafId: GRID_LEAF_C,
        splitFromLeafId: GRID_LEAF_B,
        splitSourceLeafIds: [GRID_LEAF_A, GRID_LEAF_B],
        splitDirection: 'vertical',
        placement: 'orchestration-grid'
      })
    }

    function queueFocusedRendererAppend(
      harness: GridLifecycleHarness,
      requestId = 'renderer-transaction'
    ): void {
      harness.requestTerminalCreate({
        requestId,
        worktreeId: GRID_WORKTREE_ID,
        command: 'codex --transaction',
        launchConfig: { agentArgs: '--transaction', agentEnv: {} },
        launchAgent: 'codex',
        title: 'Worker C',
        presentation: 'focused',
        placement: 'orchestration-grid'
      })
    }

    function expectActionRemovedAfterSettlement(harness: GridLifecycleHarness): void {
      const replyCount = harness.replyTerminalCreate.mock.calls.length
      const unregisterLateConsumer = harness.registerConsumer()
      expect(harness.replyTerminalCreate).toHaveBeenCalledTimes(replyCount)
      unregisterLateConsumer()
    }

    afterEach(() => {
      vi.useRealTimers()
    })

    it('consumes two queued PTY-backed appends from the freshest grid state', async () => {
      vi.useFakeTimers()
      const harness = await setupGridLifecycleHarness()
      harness.setGridLayout(fullGridRowLayout())

      harness.createTerminal({
        requestId: 'pty-append-c',
        worktreeId: GRID_WORKTREE_ID,
        command: 'codex --worker-c',
        launchConfig: { agentArgs: '--worker-c', agentEnv: {} },
        launchAgent: 'codex',
        title: 'Worker C',
        ptyId: 'pty-grid-c',
        presentation: 'focused',
        tabId: GRID_TAB_ID,
        leafId: GRID_LEAF_C,
        splitFromLeafId: GRID_LEAF_B,
        splitSourceLeafIds: [GRID_LEAF_A, GRID_LEAF_B],
        splitDirection: 'vertical',
        placement: 'orchestration-grid'
      })
      harness.createTerminal({
        requestId: 'pty-append-d',
        worktreeId: GRID_WORKTREE_ID,
        command: 'codex --worker-d',
        title: 'Worker D',
        ptyId: 'pty-grid-d',
        presentation: 'background',
        tabId: GRID_TAB_ID,
        leafId: GRID_LEAF_D,
        splitFromLeafId: GRID_LEAF_B,
        splitSourceLeafIds: [GRID_LEAF_A, GRID_LEAF_B],
        splitDirection: 'vertical',
        placement: 'orchestration-grid'
      })
      harness.setActiveGridLeaf(GRID_LEAF_B)

      const unregister = harness.registerConsumer()
      const layout = (
        harness.getState().terminalLayoutsByTabId as Record<string, TerminalLayoutSnapshot>
      )[GRID_TAB_ID]!
      const events = splitEvents(harness)

      expect(collectTerminalLayoutLeafIds(layout.root)).toEqual([
        GRID_LEAF_A,
        GRID_LEAF_B,
        GRID_LEAF_E,
        GRID_LEAF_F,
        GRID_LEAF_G,
        GRID_LEAF_H,
        GRID_LEAF_C,
        GRID_LEAF_D
      ])
      expect(layout.activeLeafId).toBe(GRID_LEAF_C)
      expect(layout.ptyIdsByLeafId).toEqual({
        [GRID_LEAF_A]: 'pty-grid-a',
        [GRID_LEAF_B]: 'pty-grid-b',
        [GRID_LEAF_E]: 'pty-grid-e',
        [GRID_LEAF_F]: 'pty-grid-f',
        [GRID_LEAF_G]: 'pty-grid-g',
        [GRID_LEAF_H]: 'pty-grid-h',
        [GRID_LEAF_C]: 'pty-grid-c',
        [GRID_LEAF_D]: 'pty-grid-d'
      })
      expect(layout.titlesByLeafId).toEqual({
        [GRID_LEAF_A]: 'Worker A',
        [GRID_LEAF_B]: 'Worker B',
        [GRID_LEAF_E]: 'Worker E',
        [GRID_LEAF_F]: 'Worker F',
        [GRID_LEAF_G]: 'Worker G',
        [GRID_LEAF_H]: 'Worker H',
        [GRID_LEAF_C]: 'Worker C',
        [GRID_LEAF_D]: 'Worker D'
      })
      expect(events.map((event) => event.detail)).toMatchObject([
        {
          direction: 'horizontal',
          sourceLeafId: GRID_LEAF_H,
          sourceLeafIds: [
            GRID_LEAF_A,
            GRID_LEAF_B,
            GRID_LEAF_E,
            GRID_LEAF_F,
            GRID_LEAF_G,
            GRID_LEAF_H
          ],
          sourcePtyId: 'pty-grid-h',
          newLeafId: GRID_LEAF_C,
          ptyId: 'pty-grid-c',
          activate: true
        },
        {
          direction: 'vertical',
          sourceLeafId: GRID_LEAF_C,
          sourceLeafIds: [GRID_LEAF_C],
          sourcePtyId: 'pty-grid-c',
          newLeafId: GRID_LEAF_D,
          ptyId: 'pty-grid-d',
          activate: false
        }
      ])
      expect(harness.replyTerminalCreate.mock.calls.map(([reply]) => reply.requestId)).toEqual([
        'pty-append-c',
        'pty-append-d'
      ])
      expect(harness.focusRuntimeTerminalSurface).toHaveBeenCalledTimes(1)
      expect(harness.focusRuntimeTerminalSurface).toHaveBeenCalledWith(GRID_TAB_ID, GRID_LEAF_C)
      expect(harness.updateTabPtyId.mock.calls).toEqual([
        [GRID_TAB_ID, 'pty-grid-c'],
        [GRID_TAB_ID, 'pty-grid-d']
      ])
      expect(harness.dispatchEvent.mock.invocationCallOrder[0]).toBeLessThan(
        harness.updateTabPtyId.mock.invocationCallOrder[0] ?? 0
      )
      expect(harness.dispatchEvent.mock.invocationCallOrder[1]).toBeLessThan(
        harness.updateTabPtyId.mock.invocationCallOrder[1] ?? 0
      )
      expect(vi.getTimerCount()).toBe(0)

      unregister()
      harness.dispose()
      vi.useRealTimers()
    })

    it('consumes two queued renderer-backed appends in canonical grid order', async () => {
      vi.useFakeTimers()
      const harness = await setupGridLifecycleHarness()
      harness.setGridLayout(fullGridRowLayout())

      harness.requestTerminalCreate({
        requestId: 'request-append-c',
        worktreeId: GRID_WORKTREE_ID,
        command: 'codex --worker-c',
        launchConfig: { agentArgs: '--worker-c', agentEnv: {} },
        launchAgent: 'codex',
        title: 'Worker C',
        presentation: 'focused',
        placement: 'orchestration-grid'
      })
      harness.requestTerminalCreate({
        requestId: 'request-append-d',
        worktreeId: GRID_WORKTREE_ID,
        command: 'codex --worker-d',
        title: 'Worker D',
        presentation: 'background',
        placement: 'orchestration-grid'
      })
      harness.setActiveGridLeaf(GRID_LEAF_B)

      const unregister = harness.registerConsumer()
      const layout = (
        harness.getState().terminalLayoutsByTabId as Record<string, TerminalLayoutSnapshot>
      )[GRID_TAB_ID]!
      const events = splitEvents(harness)
      const appendedLeafIds = events.map((event) => event.detail.newLeafId!)

      expect(collectTerminalLayoutLeafIds(layout.root)).toEqual([
        GRID_LEAF_A,
        GRID_LEAF_B,
        GRID_LEAF_E,
        GRID_LEAF_F,
        GRID_LEAF_G,
        GRID_LEAF_H,
        ...appendedLeafIds
      ])
      expect(layout.activeLeafId).toBe(appendedLeafIds[0])
      expect(Object.values(layout.titlesByLeafId ?? {})).toEqual([
        'Worker A',
        'Worker B',
        'Worker E',
        'Worker F',
        'Worker G',
        'Worker H',
        'Worker C',
        'Worker D'
      ])
      expect(events.map((event) => event.detail)).toMatchObject([
        {
          direction: 'horizontal',
          sourceLeafId: GRID_LEAF_H,
          sourceLeafIds: [
            GRID_LEAF_A,
            GRID_LEAF_B,
            GRID_LEAF_E,
            GRID_LEAF_F,
            GRID_LEAF_G,
            GRID_LEAF_H
          ],
          newLeafId: appendedLeafIds[0],
          startup: { command: 'codex --worker-c' },
          activate: true
        },
        {
          direction: 'vertical',
          sourceLeafId: appendedLeafIds[0],
          sourceLeafIds: [appendedLeafIds[0]],
          newLeafId: appendedLeafIds[1],
          startup: { command: 'codex --worker-d' },
          activate: false
        }
      ])
      expect(harness.replyTerminalCreate.mock.calls.map(([reply]) => reply)).toMatchObject([
        { requestId: 'request-append-c', leafId: appendedLeafIds[0] },
        { requestId: 'request-append-d', leafId: appendedLeafIds[1] }
      ])
      expect(harness.focusRuntimeTerminalSurface).toHaveBeenCalledTimes(1)
      expect(harness.focusRuntimeTerminalSurface).toHaveBeenCalledWith(
        GRID_TAB_ID,
        appendedLeafIds[0]
      )
      expect(vi.getTimerCount()).toBe(0)

      unregister()
      harness.dispose()
      vi.useRealTimers()
    })

    it.each(['binding', 'layout', 'dispatch'] as const)(
      'rolls back a PTY-backed append when %s throws before commit',
      async (failureStep) => {
        vi.useFakeTimers()
        const harness = await setupGridLifecycleHarness()
        queueFocusedPtyAppend(harness)
        harness.setActiveGridLeaf(GRID_LEAF_B)
        const stateBeforeConsumption = rendererStateSnapshot(harness)
        harness.setFailureStep(failureStep)

        const unregister = harness.registerConsumer()

        expect(rendererStateSnapshot(harness)).toEqual(stateBeforeConsumption)
        expect(harness.replyTerminalCreate).toHaveBeenCalledOnce()
        expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
          requestId: 'pty-transaction',
          error: `${failureStep} failed`
        })
        expect(harness.getOrphanResourceCount()).toBe(0)
        expect(harness.getRollbackCount()).toBe(failureStep === 'dispatch' ? 0 : 1)
        if (failureStep === 'binding') {
          expect(harness.updateTabPtyId).toHaveBeenCalledOnce()
        } else {
          expect(harness.updateTabPtyId).not.toHaveBeenCalled()
        }
        expect(harness.getState().agentLaunchConfigByPaneKey).toEqual({})
        expect(vi.getTimerCount()).toBe(0)
        unregister()
        expectActionRemovedAfterSettlement(harness)
        harness.dispose()
      }
    )

    it('rejects a PTY-backed append when the split event has no listener', async () => {
      vi.useFakeTimers()
      const harness = await setupGridLifecycleHarness()
      queueFocusedPtyAppend(harness)
      harness.setActiveGridLeaf(GRID_LEAF_B)
      const stateBeforeConsumption = rendererStateSnapshot(harness)
      harness.setFailureStep('listener-absent')

      const unregister = harness.registerConsumer()

      expect(rendererStateSnapshot(harness)).toEqual(stateBeforeConsumption)
      expect(harness.replyTerminalCreate).toHaveBeenCalledOnce()
      expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
        requestId: 'pty-transaction',
        error: `Terminal split event for ${GRID_TAB_ID} was not acknowledged`
      })
      expect(harness.setActiveWorktree).not.toHaveBeenCalled()
      expect(harness.markWorktreeVisited).not.toHaveBeenCalled()
      expect(harness.revealWorktreeInSidebar).not.toHaveBeenCalled()
      expect(harness.updateTabPtyId).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      unregister()
      expectActionRemovedAfterSettlement(harness)
      harness.dispose()
    })

    it('retries a transient rollback cleanup before discarding the acknowledgement', async () => {
      vi.useFakeTimers()
      const harness = await setupGridLifecycleHarness()
      queueFocusedPtyAppend(harness, 'rollback-cleanup')
      harness.setFailureStep('rollback-cleanup')

      const unregister = harness.registerConsumer()

      expect(harness.getRollbackCount()).toBe(2)
      expect(harness.getOrphanResourceCount()).toBe(0)
      expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
        requestId: 'rollback-cleanup',
        error: 'layout failed'
      })
      unregister()
      expectActionRemovedAfterSettlement(harness)
      harness.dispose()
    })

    it.each([
      {
        path: 'renderer-backed',
        failureStep: 'listener-absent' as const,
        expectedError: 'was not acknowledged',
        expectedRollbacks: 0
      },
      ...(
        [
          ['split-null', 'did not create a pane', 0],
          ['listener-throw', 'listener failed', 1],
          ['partial-create', 'partial create failed', 1],
          ['wrong-tab', 'was not acknowledged', 0],
          ['manager-absent', 'manager', 0],
          ['invalid-source', 'source', 0],
          ['duplicate-leaf', 'already exists', 0]
        ] as const
      ).flatMap(([failureStep, expectedError, expectedRollbacks]) =>
        (['PTY-backed', 'renderer-backed'] as const).map((path) => ({
          path,
          failureStep,
          expectedError,
          expectedRollbacks
        }))
      )
    ])(
      'compensates a $path append after $failureStep and settles it once',
      async ({ path, failureStep, expectedError, expectedRollbacks }) => {
        vi.useFakeTimers()
        const harness = await setupGridLifecycleHarness()
        const requestId = `${path}-${failureStep}`
        if (path === 'PTY-backed') {
          queueFocusedPtyAppend(harness, requestId)
        } else {
          queueFocusedRendererAppend(harness, requestId)
        }
        harness.setActiveGridLeaf(GRID_LEAF_B)
        const stateBeforeConsumption = rendererStateSnapshot(harness)
        harness.setFailureStep(failureStep)

        const unregister = harness.registerConsumer()

        expect(rendererStateSnapshot(harness)).toEqual(stateBeforeConsumption)
        expect(harness.getOrphanResourceCount()).toBe(0)
        expect(harness.getRollbackCount()).toBe(expectedRollbacks)
        expect(harness.updateTabPtyId).not.toHaveBeenCalled()
        expect(harness.replyTerminalCreate).toHaveBeenCalledOnce()
        expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
          requestId,
          error: expect.stringContaining(expectedError)
        })
        expect(vi.getTimerCount()).toBe(0)
        unregister()
        expectActionRemovedAfterSettlement(harness)
        harness.dispose()
      }
    )

    it.each(['layout', 'dispatch'] as const)(
      'rolls back a renderer-backed append when %s throws before commit',
      async (failureStep) => {
        vi.useFakeTimers()
        const harness = await setupGridLifecycleHarness()
        queueFocusedRendererAppend(harness)
        harness.setActiveGridLeaf(GRID_LEAF_B)
        const stateBeforeConsumption = rendererStateSnapshot(harness)
        harness.setFailureStep(failureStep)

        const unregister = harness.registerConsumer()

        expect(rendererStateSnapshot(harness)).toEqual(stateBeforeConsumption)
        expect(harness.replyTerminalCreate).toHaveBeenCalledOnce()
        expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
          requestId: 'renderer-transaction',
          error: `${failureStep} failed`
        })
        expect(harness.getOrphanResourceCount()).toBe(0)
        expect(harness.getRollbackCount()).toBe(failureStep === 'layout' ? 1 : 0)
        expect(harness.updateTabPtyId).not.toHaveBeenCalled()
        expect(harness.getState().agentLaunchConfigByPaneKey).toEqual({})
        expect(vi.getTimerCount()).toBe(0)
        unregister()
        expectActionRemovedAfterSettlement(harness)
        harness.dispose()
      }
    )

    it.each(['activation', 'sidebar', 'runtime-focus', 'tab-focus'] as const)(
      'keeps a committed PTY-backed append consumed when post-commit %s throws',
      async (failureStep) => {
        vi.useFakeTimers()
        const harness = await setupGridLifecycleHarness()
        queueFocusedPtyAppend(harness, `pty-${failureStep}`)
        harness.setFailureStep(failureStep)

        const unregister = harness.registerConsumer()
        const state = harness.getState()
        const layout = (state.terminalLayoutsByTabId as Record<string, TerminalLayoutSnapshot>)[
          GRID_TAB_ID
        ]!

        expect(collectTerminalLayoutLeafIds(layout.root)).toEqual([
          GRID_LEAF_A,
          GRID_LEAF_B,
          GRID_LEAF_C
        ])
        expect(layout.activeLeafId).toBe(GRID_LEAF_C)
        expect(layout.ptyIdsByLeafId?.[GRID_LEAF_C]).toBe('pty-grid-c')
        expect(state.agentLaunchConfigByPaneKey).toHaveProperty(
          makePaneKey(GRID_TAB_ID, GRID_LEAF_C)
        )
        expect(splitEvents(harness)).toHaveLength(1)
        expect(harness.replyTerminalCreate).toHaveBeenCalledOnce()
        expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
          requestId: `pty-${failureStep}`,
          tabId: GRID_TAB_ID,
          leafId: GRID_LEAF_C,
          layout,
          title: 'Worker C'
        })
        expect(vi.getTimerCount()).toBe(0)
        unregister()
        expectActionRemovedAfterSettlement(harness)
        harness.dispose()
      }
    )

    it.each(['activation', 'sidebar', 'runtime-focus', 'tab-focus'] as const)(
      'keeps a committed renderer-backed append consumed when post-commit %s throws',
      async (failureStep) => {
        vi.useFakeTimers()
        const harness = await setupGridLifecycleHarness()
        queueFocusedRendererAppend(harness, `renderer-${failureStep}`)
        harness.setFailureStep(failureStep)

        const unregister = harness.registerConsumer()
        const event = splitEvents(harness)[0]!
        const appendedLeafId = event.detail.newLeafId!
        const state = harness.getState()
        const layout = (state.terminalLayoutsByTabId as Record<string, TerminalLayoutSnapshot>)[
          GRID_TAB_ID
        ]!

        expect(collectTerminalLayoutLeafIds(layout.root)).toEqual([
          GRID_LEAF_A,
          GRID_LEAF_B,
          appendedLeafId
        ])
        expect(layout.activeLeafId).toBe(appendedLeafId)
        expect(layout.titlesByLeafId?.[appendedLeafId]).toBe('Worker C')
        expect(state.agentLaunchConfigByPaneKey).toHaveProperty(
          makePaneKey(GRID_TAB_ID, appendedLeafId)
        )
        expect(harness.replyTerminalCreate).toHaveBeenCalledOnce()
        expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
          requestId: `renderer-${failureStep}`,
          tabId: GRID_TAB_ID,
          leafId: appendedLeafId,
          layout,
          title: 'Worker C'
        })
        expect(vi.getTimerCount()).toBe(0)
        unregister()
        expectActionRemovedAfterSettlement(harness)
        harness.dispose()
      }
    )
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

    const previousStoreState = { ...storeState }
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
    subscribeListenerRef.current(storeState, previousStoreState)
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

  it('applies a burst leading-edge first, then coalesces the rest into one deferred batch', async () => {
    // Why: each live status event is its own IPC task, so N events used to pay
    // N full render passes (STA-3328 mechanism 2). The leading event must stay
    // synchronous (zero added latency); followers within the burst window must
    // apply together on one later task, in arrival order.
    vi.useFakeTimers()
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' }]
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

    try {
      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()
      if (typeof onSetListenerRef.current !== 'function') {
        throw new Error('Expected agentStatus.onSet listener to be registered')
      }
      const emit = (receivedAt: number, prompt: string): void => {
        onSetListenerRef.current!({
          paneKey: FUTURE_PANE_KEY,
          state: 'working',
          prompt,
          agentType: 'claude',
          receivedAt,
          stateStartedAt: receivedAt
        })
      }

      emit(1_700_000_000_000, 'first')
      expect(setAgentStatus).toHaveBeenCalledTimes(1)

      emit(1_700_000_000_001, 'second')
      emit(1_700_000_000_002, 'third')
      expect(setAgentStatus).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(40)
      expect(setAgentStatus).toHaveBeenCalledTimes(3)
      expect(setAgentStatus.mock.calls[1][1]).toEqual(expect.objectContaining({ prompt: 'second' }))
      expect(setAgentStatus.mock.calls[2][1]).toEqual(expect.objectContaining({ prompt: 'third' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves queued set-clear order for working removal and done retention', async () => {
    vi.useFakeTimers()
    let storeState: StoreLike
    const setAgentStatus = vi.fn(
      (
        paneKey: string,
        payload: { state: string },
        _title: unknown,
        timing: { updatedAt: number }
      ) => {
        storeState.agentStatusByPaneKey = {
          ...(storeState.agentStatusByPaneKey as Record<string, unknown>),
          [paneKey]: { ...payload, updatedAt: timing.updatedAt }
        }
      }
    )
    const removeAgentStatus = vi.fn((paneKey: string) => {
      const next = { ...(storeState.agentStatusByPaneKey as Record<string, unknown>) }
      delete next[paneKey]
      storeState.agentStatusByPaneKey = next
    })
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const onClearListenerRef: { current: ((data: { paneKey: string }) => void) | null } = {
      current: null
    }
    storeState = buildStoreState({
      setAgentStatus,
      removeAgentStatus,
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' }]
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
        },
        onClear: (cb) => {
          onClearListenerRef.current = cb as (data: { paneKey: string }) => void
          return () => {}
        }
      })
    )

    try {
      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()
      if (
        typeof onSetListenerRef.current !== 'function' ||
        typeof onClearListenerRef.current !== 'function'
      ) {
        throw new Error('Expected agentStatus listeners to be registered')
      }
      const emit = (
        receivedAt: number,
        prompt: string,
        state: AgentStatusSetData['state'] = 'working'
      ): void => {
        onSetListenerRef.current!({
          paneKey: FUTURE_PANE_KEY,
          state,
          prompt,
          agentType: 'claude',
          receivedAt,
          stateStartedAt: receivedAt
        })
      }

      emit(1_700_000_000_000, 'leading')
      emit(1_700_000_000_001, 'queued')
      expect(setAgentStatus).toHaveBeenCalledTimes(1)

      onClearListenerRef.current({ paneKey: FUTURE_PANE_KEY })
      expect(removeAgentStatus).toHaveBeenCalledWith(FUTURE_PANE_KEY)
      expect(storeState.agentStatusByPaneKey).toEqual({})

      vi.advanceTimersByTime(40)
      expect(setAgentStatus).toHaveBeenCalledTimes(2)
      expect(storeState.agentStatusByPaneKey).toEqual({})

      emit(1_700_000_000_002, 'task')
      emit(1_700_000_000_003, 'task', 'done')
      expect(setAgentStatus).toHaveBeenCalledTimes(3)

      onClearListenerRef.current({ paneKey: FUTURE_PANE_KEY })

      expect(setAgentStatus).toHaveBeenCalledTimes(4)
      expect(setAgentStatus.mock.calls[3][1]).toEqual(expect.objectContaining({ state: 'done' }))
      expect(removeAgentStatus).toHaveBeenCalledTimes(1)
      expect(storeState.agentStatusByPaneKey).toEqual({
        [FUTURE_PANE_KEY]: expect.objectContaining({ state: 'done' })
      })
      vi.advanceTimersByTime(40)
      expect(setAgentStatus).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not recurse when flushing a pending status re-enters via the store subscriber', async () => {
    // Repro for crash 9fc89529 (RangeError: Maximum call stack size exceeded):
    // the store subscriber calls flushPendingAgentStatuses() on every update.
    // flush -> applyAgentStatus -> store.setAgentStatus notifies subscribers
    // synchronously (like Zustand) -> subscriber -> flush again while the same
    // event is still queued -> infinite recursion. Model setAgentStatus with a
    // real synchronous notify so the re-entrancy is exercised end to end.
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    let setAgentStatusCalls = 0
    const notify = (): void => {
      const listener = subscribeListenerRef.current
      if (listener) {
        listener(storeState, storeState)
      }
    }
    const storeState: StoreLike = buildStoreState({
      // Why: mirror Zustand — a state mutation notifies subscribers synchronously.
      setAgentStatus: (paneKey: string, entry: unknown) => {
        setAgentStatusCalls += 1
        storeState.agentStatusByPaneKey = {
          ...(storeState.agentStatusByPaneKey as Record<string, unknown>),
          [paneKey]: entry
        }
        notify()
      },
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      // Pane does not exist yet -> the incoming event is buffered as pending.
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
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
    if (typeof subscribeListenerRef.current !== 'function') {
      throw new Error('Expected useAppStore.subscribe listener to be registered')
    }

    // Event lands before the tab exists -> buffered as a pending retry.
    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'p',
      agentType: 'claude',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })
    expect(setAgentStatusCalls).toBe(0)

    // Tab hydrates; the next store update flushes the pending event. Without the
    // re-entrancy guard this overflows the stack instead of applying once.
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

    expect(() => notify()).not.toThrow()
    // Applied exactly once — the re-entrant flush is a no-op, not a loop.
    expect(setAgentStatusCalls).toBe(1)
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

  it('suppresses auto-approved Codex permission attention before status and title mutation', async () => {
    const setAgentStatus = vi.fn()
    const updateTabTitle = vi.fn()
    const observeAgentHookCompletionForNotification = vi.fn()
    const getAgentLaunchConfigForStatusMetadata = vi.fn((metadata: { launchToken?: string }) =>
      metadata.launchToken === 'launch-yolo'
        ? { agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '', agentEnv: {} }
        : undefined
    )
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      updateTabTitle,
      getAgentLaunchConfigForStatusMetadata,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: true, agentTaskComplete: true } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Codex' }]
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
    vi.doMock('./agent-hook-completion-notifications', () => ({
      observeAgentHookCompletionForNotification,
      resetAgentHookCompletionNotificationCoordinators: vi.fn(),
      syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
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
      tabId: 'tab-future',
      worktreeId: 'wt-1',
      state: 'waiting',
      prompt: 'auto-approved permission',
      agentType: 'codex',
      launchToken: 'launch-yolo',
      receivedAt: 1_700_000_000_300,
      stateStartedAt: 1_699_999_999_300
    })

    expect(getAgentLaunchConfigForStatusMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ paneKey: FUTURE_PANE_KEY, launchToken: 'launch-yolo' })
    )
    expect(setAgentStatus).not.toHaveBeenCalled()
    expect(updateTabTitle).not.toHaveBeenCalled()
    expect(observeAgentHookCompletionForNotification).not.toHaveBeenCalled()
  })

  it('keeps manual or missing-attribution Codex permission attention actionable', async () => {
    const setAgentStatus = vi.fn()
    const updateTabTitle = vi.fn()
    const observeAgentHookCompletionForNotification = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      updateTabTitle,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: true, agentTaskComplete: true } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Codex' }]
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
    vi.doMock('./agent-hook-completion-notifications', () => ({
      observeAgentHookCompletionForNotification,
      resetAgentHookCompletionNotificationCoordinators: vi.fn(),
      syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
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
      tabId: 'tab-future',
      worktreeId: 'wt-1',
      state: 'waiting',
      prompt: 'manual permission',
      agentType: 'codex',
      receivedAt: 1_700_000_000_400,
      stateStartedAt: 1_699_999_999_400
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'waiting',
        prompt: 'manual permission',
        agentType: 'codex'
      }),
      'Codex - action required',
      { updatedAt: 1_700_000_000_400, stateStartedAt: 1_699_999_999_400 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
    expect(updateTabTitle).toHaveBeenCalledWith('tab-future', 'Codex - action required')
    expect(observeAgentHookCompletionForNotification).toHaveBeenCalledTimes(1)
  })

  it('does not send an out-of-order hook event to completion lifecycle tracking', async () => {
    const setAgentStatus = vi.fn()
    const updateTabTitle = vi.fn()
    const observeAgentHookCompletionForNotification = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      updateTabTitle,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: true, agentTaskComplete: true } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Claude' }]
      },
      agentStatusByPaneKey: {
        [FUTURE_PANE_KEY]: {
          state: 'working',
          prompt: 'newer turn',
          agentType: 'claude',
          updatedAt: 1_700_000_000_500,
          stateStartedAt: 1_700_000_000_400
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
    vi.doMock('./agent-hook-completion-notifications', () => ({
      observeAgentHookCompletionForNotification,
      resetAgentHookCompletionNotificationCoordinators: vi.fn(),
      syncAgentHookCompletionNotificationSettings: vi.fn()
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
      tabId: 'tab-future',
      worktreeId: 'wt-1',
      state: 'done',
      prompt: 'older turn',
      agentType: 'claude',
      receivedAt: 1_700_000_000_300,
      stateStartedAt: 1_700_000_000_200
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
    expect(updateTabTitle).not.toHaveBeenCalled()
    expect(observeAgentHookCompletionForNotification).not.toHaveBeenCalled()
  })

  it('keeps auto-approved Codex done statuses on the completion path', async () => {
    const setAgentStatus = vi.fn()
    const observeAgentHookCompletionForNotification = vi.fn()
    const getAgentLaunchConfigForStatusMetadata = vi.fn((metadata: { launchToken?: string }) =>
      metadata.launchToken === 'launch-yolo'
        ? { agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '', agentEnv: {} }
        : undefined
    )
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      getAgentLaunchConfigForStatusMetadata,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: true, agentTaskComplete: true } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Codex' }]
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
    vi.doMock('./agent-hook-completion-notifications', () => ({
      observeAgentHookCompletionForNotification,
      resetAgentHookCompletionNotificationCoordinators: vi.fn(),
      syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
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
      tabId: 'tab-future',
      worktreeId: 'wt-1',
      state: 'done',
      prompt: 'auto-approved task',
      agentType: 'codex',
      launchToken: 'launch-yolo',
      lastAssistantMessage: 'Done.',
      receivedAt: 1_700_000_000_500,
      stateStartedAt: 1_699_999_999_500
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(observeAgentHookCompletionForNotification).toHaveBeenCalledTimes(1)
    expect(observeAgentHookCompletionForNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: FUTURE_PANE_KEY,
        worktreeId: 'wt-1',
        payload: expect.objectContaining({ state: 'done', agentType: 'codex' })
      })
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
    const onClearListenerRef: {
      current: ((data: AgentStatusClearIpcPayload) => void) | null
    } = {
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

  it('blocks cleared snapshots across remount and accepts newer reconnect replay', async () => {
    let resolveOldSnapshot!: (entries: AgentStatusSetData[]) => void
    let resolveCurrentSnapshot!: (entries: AgentStatusSetData[]) => void
    const oldSnapshot = new Promise<AgentStatusSetData[]>((resolve) => {
      resolveOldSnapshot = resolve
    })
    const currentSnapshot = new Promise<AgentStatusSetData[]>((resolve) => {
      resolveCurrentSnapshot = resolve
    })
    const effectCleanups: (() => void)[] = []
    const setAgentStatus = vi.fn()
    const clearTransientAgentStatuses = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const onClearListenerRef: {
      current: ((data: AgentStatusClearIpcPayload) => void) | null
    } = { current: null }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      clearTransientAgentStatuses,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      repos: [{ id: 'repo-1', connectionId: 'ssh-a' }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Remote agent' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': { root: { type: 'leaf', leafId: FUTURE_LEAF_ID } }
      }
    })

    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return {
        ...actual,
        useEffect: (effect: () => void | (() => void)) => {
          const cleanup = effect()
          effectCleanups.push(typeof cleanup === 'function' ? cleanup : () => {})
        }
      }
    })
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
        onSet: (callback) => {
          onSetListenerRef.current = callback
          return () => {}
        },
        onClear: (callback) => {
          onClearListenerRef.current = callback
          return () => {}
        },
        getSnapshot: vi.fn().mockReturnValueOnce(oldSnapshot).mockReturnValueOnce(currentSnapshot)
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()
    effectCleanups[0]?.()
    useIpcEvents()
    await Promise.resolve()
    if (!onSetListenerRef.current || !onClearListenerRef.current) {
      throw new Error('Expected agent status listeners to be registered')
    }

    expect(() =>
      onClearListenerRef.current?.(null as unknown as AgentStatusClearIpcPayload)
    ).not.toThrow()
    expect(clearTransientAgentStatuses).not.toHaveBeenCalled()

    onClearListenerRef.current({
      transient: true,
      connectionId: 'ssh-a',
      clearedAt: 100
    })
    const staleEntry: AgentStatusSetData = {
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'stale snapshot',
      agentType: 'codex',
      worktreeId: 'wt-1',
      connectionId: 'ssh-a',
      receivedAt: 100,
      stateStartedAt: 90
    }
    resolveOldSnapshot([staleEntry])
    resolveCurrentSnapshot([staleEntry])
    await Promise.resolve()
    await Promise.resolve()

    expect(clearTransientAgentStatuses).toHaveBeenCalledWith('ssh-a', 100)
    expect(setAgentStatus).not.toHaveBeenCalled()

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'replayed',
      agentType: 'codex',
      worktreeId: 'wt-1',
      connectionId: 'ssh-a',
      receivedAt: 101,
      stateStartedAt: 101
    })

    expect(setAgentStatus).toHaveBeenCalledOnce()
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({ prompt: 'replayed' }),
      'Remote agent',
      { updatedAt: 101, stateStartedAt: 101 },
      expect.objectContaining({ worktreeId: 'wt-1', connectionId: 'ssh-a' }),
      undefined
    )
  })

  it('keeps a completed worktree-attributed row when main reports pane teardown', async () => {
    const removeAgentStatus = vi.fn()
    const onClearListenerRef: {
      current: ((data: AgentStatusClearIpcPayload) => void) | null
    } = {
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

    const previousStoreState = { ...storeState }
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
    subscribeListenerRef.current(storeState, previousStoreState)

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

  it('preserves a SessionStart boundary from snapshot IPC without completion side effects', async () => {
    const now = Date.now()
    const refreshGitHubForWorktreeIfStale = vi.fn()
    const observeAgentHookCompletionForNotification = vi.fn()
    const store = createTestStore()
    store.setState({
      workspaceSessionReady: true,
      repos: [{ ...TEST_REPO, connectionId: null, executionHostId: 'local' }],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })]
      },
      tabsByWorktree: {
        'wt-1': [
          makeTab({
            id: 'tab-future',
            ptyId: 'pty-1',
            worktreeId: 'wt-1',
            title: 'Claude'
          })
        ]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      },
      refreshGitHubForWorktreeIfStale
    })
    store
      .getState()
      .setAgentStatus(
        FUTURE_PANE_KEY,
        { state: 'working', prompt: 'resumed task', agentType: 'claude' },
        'Claude',
        { updatedAt: now - 2, stateStartedAt: now - 2 },
        { tabId: 'tab-future', worktreeId: 'wt-1' }
      )

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: store.subscribe,
        getState: store.getState
      }
    }))
    vi.doMock('./agent-hook-completion-notifications', () => ({
      observeAgentHookCompletionForNotification,
      resetAgentHookCompletionNotificationCoordinators: vi.fn(),
      syncAgentHookCompletionNotificationSettings: vi.fn(),
      syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot: () =>
          Promise.resolve([
            {
              paneKey: FUTURE_PANE_KEY,
              tabId: 'tab-future',
              worktreeId: 'wt-1',
              state: 'done',
              prompt: '',
              agentType: 'claude',
              sessionBoundary: true,
              receivedAt: now,
              stateStartedAt: now
            }
          ]),
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    await vi.waitFor(() => {
      expect(store.getState().agentStatusByPaneKey[FUTURE_PANE_KEY]).toMatchObject({
        state: 'done',
        sessionBoundary: true
      })
    })
    await Promise.resolve()

    expect(refreshGitHubForWorktreeIfStale).not.toHaveBeenCalled()
    expect(observeAgentHookCompletionForNotification).not.toHaveBeenCalled()
  })

  it('queues replayed startup snapshots until the pane hydrates', async () => {
    const setAgentStatus = vi.fn()
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }
    let resolveSnapshot!: (entries: AgentStatusSetData[]) => void
    const getSnapshot = vi.fn(
      () =>
        new Promise<AgentStatusSetData[]>((resolve) => {
          resolveSnapshot = resolve
        })
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      repos: [],
      worktreesByRepo: {}
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

    resolveSnapshot([
      {
        paneKey: FUTURE_PANE_KEY,
        tabId: 'tab-future',
        worktreeId: 'wt-1',
        connectionId: 'ssh-1',
        state: 'working',
        prompt: 'PreToolUse: Bash',
        agentType: 'codex',
        toolName: 'Bash',
        toolInput: 'pnpm test',
        terminalHandle: 'term-future',
        receivedAt: 1_700_000_000_000,
        stateStartedAt: 1_699_999_999_000
      }
    ])
    await Promise.resolve()
    await Promise.resolve()

    expect(setAgentStatus).not.toHaveBeenCalled()

    Object.assign(storeState, {
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'SSH Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      }
    })
    subscribeListenerRef.current?.(storeState, storeState)

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'working',
        prompt: 'PreToolUse: Bash',
        agentType: 'codex',
        toolName: 'Bash',
        toolInput: 'pnpm test'
      }),
      'SSH Tab',
      { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('suppresses notifications for replayed done snapshots after pane hydration', async () => {
    const setAgentStatus = vi.fn()
    const observeAgentHookCompletionForNotification = vi.fn()
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }
    let resolveSnapshot!: (entries: AgentStatusSetData[]) => void
    const getSnapshot = vi.fn(
      () =>
        new Promise<AgentStatusSetData[]>((resolve) => {
          resolveSnapshot = resolve
        })
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: true, agentTaskComplete: true } },
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      repos: [],
      worktreesByRepo: {}
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
    vi.doMock('./agent-hook-completion-notifications', () => ({
      observeAgentHookCompletionForNotification,
      resetAgentHookCompletionNotificationCoordinators: vi.fn(),
      syncAgentHookCompletionNotificationSettings: vi.fn(),
      syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
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

    resolveSnapshot([
      {
        paneKey: FUTURE_PANE_KEY,
        tabId: 'tab-future',
        worktreeId: 'wt-1',
        connectionId: 'ssh-1',
        state: 'done',
        prompt: 'remote completion',
        agentType: 'codex',
        lastAssistantMessage: 'queued completion',
        terminalHandle: 'term-future',
        receivedAt: 1_700_000_000_000,
        stateStartedAt: 1_699_999_999_000
      }
    ])
    await Promise.resolve()
    await Promise.resolve()

    expect(setAgentStatus).not.toHaveBeenCalled()

    Object.assign(storeState, {
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'SSH Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      }
    })
    subscribeListenerRef.current?.(storeState, storeState)

    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'done',
        prompt: 'remote completion',
        agentType: 'codex',
        lastAssistantMessage: 'queued completion'
      }),
      'SSH Tab',
      { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
    expect(observeAgentHookCompletionForNotification).not.toHaveBeenCalled()
  })

  it('drops replayed startup snapshots after hydration when connection ownership mismatches', async () => {
    const setAgentStatus = vi.fn()
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }
    let resolveSnapshot!: (entries: AgentStatusSetData[]) => void
    const getSnapshot = vi.fn(
      () =>
        new Promise<AgentStatusSetData[]>((resolve) => {
          resolveSnapshot = resolve
        })
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      repos: [{ id: 'repo-1', connectionId: 'conn-actual' }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
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

    resolveSnapshot([
      {
        paneKey: FUTURE_PANE_KEY,
        tabId: 'tab-future',
        worktreeId: 'wt-1',
        connectionId: 'ssh-stale',
        state: 'done',
        prompt: 'remote completion',
        agentType: 'codex',
        terminalHandle: 'term-future',
        receivedAt: 1_700_000_000_000,
        stateStartedAt: 1_699_999_999_000
      }
    ])
    await Promise.resolve()
    await Promise.resolve()

    expect(setAgentStatus).not.toHaveBeenCalled()

    Object.assign(storeState, {
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'SSH Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      }
    })
    subscribeListenerRef.current?.(storeState, storeState)

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('accepts WSL-relayed status events for a local repo (wsl:* is transport provenance, not ownership)', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'WSL Tab' }]
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
      prompt: 'wsl p',
      agentType: 'claude',
      worktreeId: 'wt-1',
      connectionId: 'wsl:Ubuntu',
      receivedAt: 1_700_000_000_000,
      stateStartedAt: 1_699_999_999_000
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({ state: 'working', prompt: 'wsl p', agentType: 'claude' }),
      'WSL Tab',
      { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('still rejects WSL-relayed status events against an SSH-owned repo', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
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
      repos: [{ id: 'repo-1', connectionId: 'ssh-1' }],
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
      prompt: 'wsl p',
      agentType: 'claude',
      worktreeId: 'wt-1',
      connectionId: 'wsl:Ubuntu',
      receivedAt: 1_700_000_000_000,
      stateStartedAt: 1_699_999_999_000
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
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

describe('parked terminal recovery on repos:changed', () => {
  it('remounts a pane that parked on an unresolved host once repos hydrate', async () => {
    vi.resetModules()
    const remountTerminalTabForRecovery = vi.fn(() => true)
    let reposChangedListener: (() => void) | undefined

    const state = {
      settings: { activeRuntimeEnvironmentId: null },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      worktreesByRepo: { repo1: [{ id: 'wt-1', repoId: 'repo1' }] },
      folderWorkspaces: [],
      projectGroups: [],
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: {},
      remountTerminalTabForRecovery,
      fetchRepos: vi.fn(() => Promise.resolve()),
      fetchProjectGroups: vi.fn(() => Promise.resolve()),
      fetchFolderWorkspaces: vi.fn(() => Promise.resolve())
    }

    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() }
    })
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => state }
    }))
    // Why: this hook registers dozens of IPC namespaces at mount; auto-stub every
    // unspecified listener so the test asserts the repos:changed wiring, not the mock surface.
    const noopListener = (): (() => void) => () => {}
    const autoStubNamespace = new Proxy(
      {},
      {
        get:
          () =>
          (...args: unknown[]) => {
            const maybeCallback = args[0]
            if (typeof maybeCallback === 'function') {
              return noopListener()
            }
            // Why: a resolving promise would run the hook's .then() handlers against
            // store setters this test does not model, surfacing as unhandled rejections
            // that Vitest flags as possible false positives. A pending promise leaves
            // those unrelated paths dormant.
            return new Promise(() => {})
          }
      }
    )
    const api = new Proxy(
      {
        repos: {
          onChanged: (cb: () => void) => {
            reposChangedListener = cb
            return () => {}
          }
        }
      } as Record<string, unknown>,
      {
        get: (target, prop: string) => target[prop] ?? autoStubNamespace
      }
    )
    vi.stubGlobal('window', { api })

    const { recordTerminalTabParkedOnUnresolvedHost, clearTerminalTabsParkedOnUnresolvedHost } =
      await import('@/lib/parked-terminal-host-hydration')
    clearTerminalTabsParkedOnUnresolvedHost()

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    expect(reposChangedListener).toBeDefined()

    // No parked pane yet: a refresh must not remount anything.
    reposChangedListener?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(remountTerminalTabForRecovery).not.toHaveBeenCalled()

    // The pane parks (its repo row had not merged when it mounted), then repos land.
    recordTerminalTabParkedOnUnresolvedHost('wt-1', 'tab-1')
    reposChangedListener?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
    clearTerminalTabsParkedOnUnresolvedHost()
  })
})

describe('useIpcEvents silent terminal adoption (surfaceOwner: false)', () => {
  const asMock = (value: unknown): ReturnType<typeof vi.fn> => value as ReturnType<typeof vi.fn>

  function createBackgroundWorkspaceState(): HarnessStoreState {
    return createHarnessStoreState({
      tabsByWorktree: {},
      // Honour the pre-minted tab id so adoption resolves the same tab main asked for.
      createTab: vi.fn(
        (_worktreeId: string, _groupId?: string, _tabType?: string, options?: { id?: string }) => ({
          id: options?.id ?? 'tab-minted'
        })
      ),
      worktreesByRepo: {
        'repo-1': [
          { id: 'wt-1', repoId: 'repo-1' },
          { id: 'wt-2', repoId: 'repo-1' }
        ]
      }
    })
  }

  it('adopts a background workspace terminal without scrolling the sidebar to it', async () => {
    const storeState = createBackgroundWorkspaceState()
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    // Control: `orca terminal create` (no surfaceOwner) keeps its reveal so the
    // user can find the terminal they just asked for.
    harness.createTerminal({
      worktreeId: 'wt-2',
      ptyId: 'pty-cli',
      activate: false,
      tabId: 'tab-cli'
    })

    expect(storeState.createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-cli',
      activate: false,
      id: 'tab-cli'
    })
    expect(storeState.revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')

    asMock(storeState.createTab).mockClear()
    asMock(storeState.revealWorktreeInSidebar).mockClear()
    asMock(storeState.setActiveView).mockClear()
    asMock(storeState.setActiveWorktree).mockClear()
    asMock(storeState.setActiveTabType).mockClear()
    asMock(storeState.setActiveTab).mockClear()

    // Regression: a workspace created in the background spawns its agent terminal
    // here; the tab must still be adopted, but the sidebar must not scroll to it.
    harness.createTerminal({
      worktreeId: 'wt-2',
      ptyId: 'pty-background-create',
      activate: false,
      surfaceOwner: false,
      tabId: 'tab-background-create'
    })

    expect(storeState.createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      initialPtyId: 'pty-background-create',
      activate: false,
      id: 'tab-background-create'
    })
    expect(storeState.revealWorktreeInSidebar).not.toHaveBeenCalled()
    expect(storeState.setActiveView).not.toHaveBeenCalled()
    expect(storeState.setActiveWorktree).not.toHaveBeenCalled()
    expect(storeState.setActiveTabType).not.toHaveBeenCalled()
    expect(storeState.setActiveTab).not.toHaveBeenCalled()
  })

  it('replies to a requested terminal create without scrolling the sidebar when surfaceOwner is false', async () => {
    const storeState = createBackgroundWorkspaceState()
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    // Control: the same request without surfaceOwner still reveals its workspace.
    harness.requestTerminalCreate({
      requestId: 'req-cli',
      worktreeId: 'wt-2',
      title: 'Claude'
    })

    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-cli',
      tabId: 'tab-minted',
      title: 'Claude'
    })
    expect(storeState.revealWorktreeInSidebar).toHaveBeenCalledWith('wt-2')

    asMock(storeState.createTab).mockClear()
    asMock(storeState.revealWorktreeInSidebar).mockClear()
    asMock(storeState.setActiveView).mockClear()
    asMock(storeState.setActiveWorktree).mockClear()
    asMock(storeState.setActiveTabType).mockClear()
    asMock(storeState.setActiveTab).mockClear()
    harness.replyTerminalCreate.mockClear()

    harness.requestTerminalCreate({
      requestId: 'req-background-create',
      worktreeId: 'wt-2',
      title: 'Claude',
      surfaceOwner: false
    })

    expect(storeState.createTab).toHaveBeenCalledWith('wt-2', undefined, undefined, {
      activate: false,
      recordInteraction: false
    })
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-background-create',
      tabId: 'tab-minted',
      title: 'Claude'
    })
    expect(storeState.revealWorktreeInSidebar).not.toHaveBeenCalled()
    expect(storeState.setActiveView).not.toHaveBeenCalled()
    expect(storeState.setActiveWorktree).not.toHaveBeenCalled()
    expect(storeState.setActiveTabType).not.toHaveBeenCalled()
    expect(storeState.setActiveTab).not.toHaveBeenCalled()
  })
})

type CmdJRowIndexJumpModule = typeof CmdJRowIndexJump

describe('useIpcEvents digit-chord routing while Cmd+J is open', () => {
  function createPaletteState(activeModal: string | null): HarnessStoreState {
    return createHarnessStoreState({
      tabsByWorktree: {},
      activeModal,
      activeView: 'terminal'
    })
  }

  // Why imported after the harness: it resets the module registry, so the bus the hook publishes on
  // is only the same instance when it's loaded on the far side of that reset.
  async function loadRowJumpBus(): Promise<CmdJRowIndexJumpModule> {
    return import('@/lib/cmd-j-row-index-jump')
  }

  it('routes the workspace digit chord to the palette instead of switching workspaces', async () => {
    const harness = await loadIpcEventsHarness(createPaletteState('worktree-palette'))
    harness.useIpcEvents()
    const rowJumps: number[] = []
    const unsubscribe = (await loadRowJumpBus()).subscribeCmdJRowIndexJump((index) =>
      rowJumps.push(index)
    )

    harness.jumpToWorktreeIndex(2)
    unsubscribe()

    expect(rowJumps).toEqual([2])
  })

  it('leaves the workspace jump alone when the palette is closed', async () => {
    const harness = await loadIpcEventsHarness(createPaletteState(null), {
      visibleWorktreeIds: ['wt-a', 'wt-b', 'wt-c']
    })
    harness.useIpcEvents()
    const rowJumps: number[] = []
    const unsubscribe = (await loadRowJumpBus()).subscribeCmdJRowIndexJump((index) =>
      rowJumps.push(index)
    )

    harness.jumpToWorktreeIndex(2)
    unsubscribe()

    expect(rowJumps).toEqual([])
    // Why assert the activation and not just the silent bus: a premature return would also emit nothing.
    expect(harness.activateAndRevealWorkspace).toHaveBeenCalledWith('wt-c')
  })

  it('drops the tab digit chord rather than switching tabs behind the overlay', async () => {
    const storeState = createPaletteState('worktree-palette')
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.jumpToTabIndex(1)

    expect(storeState.setActiveTab).not.toHaveBeenCalled()
  })

  it('stops delivering row jumps after unsubscribe', async () => {
    const { emitCmdJRowIndexJump, subscribeCmdJRowIndexJump } = await loadRowJumpBus()
    const seen: number[] = []
    const unsubscribe = subscribeCmdJRowIndexJump((index) => seen.push(index))

    emitCmdJRowIndexJump(0)
    unsubscribe()
    emitCmdJRowIndexJump(1)

    expect(seen).toEqual([0])
  })
})
