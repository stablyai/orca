import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
        automations: makeEvents(),
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
          onBrowserDriverChanged: () => () => {},
          onClientHostedBrowserRowsChanged: () => () => {},
          getClientHostedBrowserRows: async () => []
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
