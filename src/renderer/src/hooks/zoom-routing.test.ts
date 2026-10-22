import type { NativeChatAppearanceSettings } from '../../../shared/native-chat-appearance-settings'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UI_ZOOM_MAX } from '../../../shared/ui-zoom-level'
import { resolveZoomTarget } from './resolve-zoom-target'

function makeTarget(args: {
  hasXtermClass?: boolean
  editorClosest?: boolean
  chatClosest?: boolean
  browserPageId?: string
  /** The page's <webview> sits in a viewport shell outside its pane. */
  viewportPageId?: string
}): {
  classList: { contains: (token: string) => boolean }
  closest: (selector: string) => object | null
} {
  const {
    hasXtermClass = false,
    editorClosest = false,
    chatClosest = false,
    browserPageId,
    viewportPageId
  } = args
  return {
    classList: {
      contains: (token: string) => hasXtermClass && token === 'xterm-helper-textarea'
    },
    closest: (selector) => {
      if (selector === '[data-browser-page-pane-id]') {
        return browserPageId ? { getAttribute: () => browserPageId } : null
      }
      if (selector === '[data-browser-page-viewport-id]') {
        return viewportPageId ? { getAttribute: () => viewportPageId } : null
      }
      return (selector === '[data-native-chat-root]' ? chatClosest : editorClosest) ? {} : null
    }
  }
}

describe('resolveZoomTarget', () => {
  it('routes focused chat content to chat while keeping other views and browser tabs on UI zoom', () => {
    const activeElement = makeTarget({ chatClosest: true })
    expect(
      resolveZoomTarget({ activeView: 'terminal', activeTabType: 'terminal', activeElement })
    ).toBe('chat')
    expect(
      resolveZoomTarget({ activeView: 'settings', activeTabType: 'terminal', activeElement })
    ).toBe('ui')
    expect(
      resolveZoomTarget({ activeView: 'terminal', activeTabType: 'browser', activeElement })
    ).toBe('ui')
  })

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

  it('routes to the page whose floating browser holds focus over another view', () => {
    expect(
      resolveZoomTarget({
        activeView: 'tasks',
        activeTabType: 'terminal',
        activeElement: makeTarget({ browserPageId: 'page-1' })
      })
    ).toBe('browser')
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
      nativeChatAppearance?: NativeChatAppearanceSettings
      editorFontZoomLevel?: number
      viewerTakesZoom?: boolean
    } = {}
  ) {
    const {
      activeView = 'terminal',
      activeTabType = 'browser',
      activeElement = makeTarget({ editorClosest: true, hasXtermClass: true }),
      uiZoomLevel = 0,
      editorFontZoomLevel = 0,
      nativeChatAppearance,
      viewerTakesZoom = false
    } = args

    const applyUIZoom = vi.fn()
    const dispatchZoomLevelChanged = vi.fn()
    const setEditorFontZoomLevel = vi.fn()
    const setUI = vi.fn()
    const settings = { terminalFontSize: 13, nativeChatAppearance }
    const updateSettings = vi.fn(async (updates: Partial<typeof settings>) => {
      Object.assign(settings, updates)
    })

    const requestViewerZoom = vi.fn(() => viewerTakesZoom)
    const dispatchBrowserPageZoom = vi.fn()
    vi.doMock('@/components/browser-pane/host-guest/browser-page-zoom', () => ({
      dispatchBrowserPageZoom
    }))
    vi.doMock('@/components/editor/viewer-zoom-request', () => ({ requestViewerZoom }))
    vi.doMock('@/lib/ui-zoom', () => ({ applyUIZoom }))
    vi.doMock('@/lib/zoom-events', () => ({ dispatchZoomLevelChanged }))
    vi.doMock('../store', () => ({
      useAppStore: {
        getState: () => ({
          activeView,
          activeTabType,
          editorFontZoomLevel,
          setEditorFontZoomLevel,
          settings,
          updateSettings
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
    return {
      fire,
      dispatchBrowserPageZoom,
      requestViewerZoom,
      applyUIZoom,
      dispatchZoomLevelChanged,
      setEditorFontZoomLevel,
      setUI,
      settings,
      updateSettings
    }
  }

  it('routes keyboard and menu zoom directions to persisted chat size, never app or editor zoom', async () => {
    const zoom = await mountZoomBridge({
      activeTabType: 'terminal',
      activeElement: makeTarget({ chatClosest: true }),
      nativeChatAppearance: { fontSize: 19, codeFontSize: 16, width: 'wide' }
    })
    zoom.fire('in')
    zoom.fire('in')
    zoom.fire('out')
    await vi.waitFor(() => expect(zoom.updateSettings).toHaveBeenCalledTimes(2))
    expect(zoom.settings.nativeChatAppearance).toEqual({
      fontSize: 19,
      codeFontSize: 16,
      width: 'wide'
    })
    zoom.fire('reset')
    await vi.waitFor(() =>
      expect(zoom.settings.nativeChatAppearance).toEqual({ codeFontSize: 16, width: 'wide' })
    )
    expect(zoom.applyUIZoom).not.toHaveBeenCalled()
    expect(zoom.setUI).not.toHaveBeenCalled()
    expect(zoom.setEditorFontZoomLevel).not.toHaveBeenCalled()
  })

  it('consumes menu chat zoom while matching without changing saved size or app zoom', async () => {
    const zoom = await mountZoomBridge({
      activeTabType: 'terminal',
      activeElement: makeTarget({ chatClosest: true }),
      nativeChatAppearance: { fontSize: 18, matchTerminalInterface: true }
    })
    zoom.fire('in')
    zoom.fire('out')
    zoom.fire('reset')
    await vi.waitFor(() => expect(zoom.settings.nativeChatAppearance?.fontSize).toBe(18))
    expect(zoom.updateSettings).not.toHaveBeenCalled()
    expect(zoom.applyUIZoom).not.toHaveBeenCalled()
    expect(zoom.setEditorFontZoomLevel).not.toHaveBeenCalled()
  })

  it('zooms the page, not the app, while focus is in its browser pane', async () => {
    const zoom = await mountZoomBridge({
      activeTabType: 'browser',
      activeElement: makeTarget({ browserPageId: 'page-1' })
    })

    zoom.fire('in')
    zoom.fire('reset')

    expect(zoom.dispatchBrowserPageZoom.mock.calls).toEqual([
      [{ browserPageId: 'page-1', direction: 'in' }],
      [{ browserPageId: 'page-1', direction: 'reset' }]
    ])
    expect(zoom.applyUIZoom).not.toHaveBeenCalled()
  })

  it('zooms the page from the View menu while the page itself holds focus', async () => {
    const zoom = await mountZoomBridge({
      activeTabType: 'browser',
      activeElement: makeTarget({ viewportPageId: 'page-1' })
    })

    zoom.fire('out')

    expect(zoom.dispatchBrowserPageZoom.mock.calls).toEqual([
      [{ browserPageId: 'page-1', direction: 'out' }]
    ])
    expect(zoom.applyUIZoom).not.toHaveBeenCalled()
  })

  it('applies app zoom for an active browser tab when focus is outside its pane', async () => {
    const zoom = await mountZoomBridge({ activeTabType: 'browser' })

    zoom.fire('in')

    expect(zoom.applyUIZoom).toHaveBeenCalledWith(0.5)
    expect(zoom.setUI).toHaveBeenCalledWith({ uiZoomLevel: 0.5 })
    // 1.2 ** 0.5 rounds to 110%, the percent the zoom overlay shows.
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

  it('hands editor-tab zoom to the PDF it shows instead of editor font zoom', async () => {
    const zoom = await mountZoomBridge({
      activeTabType: 'editor',
      activeElement: makeTarget({}),
      viewerTakesZoom: true
    })

    zoom.fire('out')

    expect(zoom.requestViewerZoom).toHaveBeenCalledWith('out')
    expect(zoom.setEditorFontZoomLevel).not.toHaveBeenCalled()
    expect(zoom.dispatchZoomLevelChanged).not.toHaveBeenCalled()
    expect(zoom.applyUIZoom).not.toHaveBeenCalled()
  })

  it('never offers app zoom outside editor tabs to a PDF', async () => {
    const zoom = await mountZoomBridge({ activeTabType: 'browser', viewerTakesZoom: true })

    zoom.fire('in')

    expect(zoom.requestViewerZoom).not.toHaveBeenCalled()
    expect(zoom.applyUIZoom).toHaveBeenCalledWith(0.5)
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
