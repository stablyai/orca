import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UI_ZOOM_MAX } from '../../../shared/ui-zoom-level'
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

describe('registerZoomIpcBridge', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  // Why the bridge and not useIpcEvents: every assertion below is zoom-ipc-bridge behavior,
  // and useIpcEvents only reaches it through app-lifetime-ipc-bridge's ~32-import graph —
  // seconds of transform per test that timed out under parallel load.
  async function mountZoomBridge(
    args: {
      activeView?: string
      activeTabType?: string
      activeElement?: ReturnType<typeof makeTarget>
      uiZoomLevel?: number
      editorFontZoomLevel?: number
    } = {}
  ) {
    const {
      activeView = 'terminal',
      activeTabType = 'browser',
      activeElement = makeTarget({ editorClosest: true, hasXtermClass: true }),
      uiZoomLevel = 0,
      editorFontZoomLevel = 0
    } = args

    const applyUIZoom = vi.fn()
    const dispatchZoomLevelChanged = vi.fn()
    const setEditorFontZoomLevel = vi.fn()
    const setUI = vi.fn()

    vi.doMock('@/lib/ui-zoom', () => ({ applyUIZoom }))
    vi.doMock('@/lib/zoom-events', () => ({ dispatchZoomLevelChanged }))
    vi.doMock('../store', () => ({
      useAppStore: {
        getState: () => ({
          activeView,
          activeTabType,
          editorFontZoomLevel,
          setEditorFontZoomLevel,
          settings: { terminalFontSize: 13 }
        })
      }
    }))

    const listenerRef: { current: ((direction: 'in' | 'out' | 'reset') => void) | null } = {
      current: null
    }
    vi.stubGlobal('document', { activeElement })
    vi.stubGlobal('window', {
      api: {
        ui: {
          onTerminalZoom: (listener: (direction: 'in' | 'out' | 'reset') => void) => {
            listenerRef.current = listener
            return () => {}
          },
          getZoomLevel: () => uiZoomLevel,
          set: setUI
        }
      }
    })

    const { registerZoomIpcBridge } = await import('./ipc-events/zoom-ipc-bridge')
    const unsubs: (() => void)[] = []
    registerZoomIpcBridge(unsubs)

    expect(unsubs).toHaveLength(1)
    const fire = listenerRef.current
    if (!fire) {
      throw new Error('Expected the terminal-zoom listener to be registered')
    }
    return { fire, applyUIZoom, dispatchZoomLevelChanged, setEditorFontZoomLevel, setUI }
  }

  it('applies app zoom for an active browser tab', async () => {
    const zoom = await mountZoomBridge({ activeTabType: 'browser' })

    zoom.fire('in')

    expect(zoom.applyUIZoom).toHaveBeenCalledWith(0.5)
    expect(zoom.setUI).toHaveBeenCalledWith({ uiZoomLevel: 0.5 })
    // 1.2 ** 0.5 rounds to 110%, the percent the zoom overlay shows.
    expect(zoom.dispatchZoomLevelChanged).toHaveBeenCalledWith('ui', 110)
  })

  it('applies app zoom for an active terminal tab after terminal focus is released', async () => {
    const zoom = await mountZoomBridge({
      activeTabType: 'terminal',
      activeElement: makeTarget({})
    })

    zoom.fire('in')

    expect(zoom.applyUIZoom).toHaveBeenCalledWith(0.5)
    expect(zoom.setUI).toHaveBeenCalledWith({ uiZoomLevel: 0.5 })
    expect(zoom.dispatchZoomLevelChanged).toHaveBeenCalledWith('ui', 110)
  })

  it('leaves zoom to the terminal while terminal input holds focus', async () => {
    const zoom = await mountZoomBridge({
      activeTabType: 'terminal',
      activeElement: makeTarget({ hasXtermClass: true })
    })

    zoom.fire('in')

    expect(zoom.applyUIZoom).not.toHaveBeenCalled()
    expect(zoom.setUI).not.toHaveBeenCalled()
    expect(zoom.dispatchZoomLevelChanged).not.toHaveBeenCalled()
  })

  it('routes an editor tab to editor font zoom instead of app zoom', async () => {
    const zoom = await mountZoomBridge({
      activeTabType: 'editor',
      activeElement: makeTarget({}),
      editorFontZoomLevel: 0
    })

    zoom.fire('in')

    expect(zoom.setEditorFontZoomLevel).toHaveBeenCalledWith(1)
    expect(zoom.setUI).toHaveBeenCalledWith({ editorFontZoomLevel: 1 })
    // 13px base + one step = 14px, reported against the base as 108%.
    expect(zoom.dispatchZoomLevelChanged).toHaveBeenCalledWith('editor', 108)
    expect(zoom.applyUIZoom).not.toHaveBeenCalled()
  })

  it('clamps app zoom at the supported maximum', async () => {
    const zoom = await mountZoomBridge({ uiZoomLevel: UI_ZOOM_MAX })

    zoom.fire('in')

    expect(zoom.applyUIZoom).toHaveBeenCalledWith(UI_ZOOM_MAX)
    expect(zoom.setUI).toHaveBeenCalledWith({ uiZoomLevel: UI_ZOOM_MAX })
  })

  it('resets app zoom to 100% regardless of the current level', async () => {
    const zoom = await mountZoomBridge({ uiZoomLevel: 2 })

    zoom.fire('reset')

    expect(zoom.applyUIZoom).toHaveBeenCalledWith(0)
    expect(zoom.setUI).toHaveBeenCalledWith({ uiZoomLevel: 0 })
    expect(zoom.dispatchZoomLevelChanged).toHaveBeenCalledWith('ui', 100)
  })
})
