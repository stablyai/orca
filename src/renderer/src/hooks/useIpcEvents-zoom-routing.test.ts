import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveZoomTarget } from './resolve-zoom-target'

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
    // Zoom routing never renders toast UI; keep Sonner's DOM style injector out of this synthetic-document harness.
    vi.doMock('sonner', () => ({
      toast: {
        dismiss: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn()
      }
    }))
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
