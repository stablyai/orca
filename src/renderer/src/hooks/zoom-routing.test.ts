import type { NativeChatAppearanceSettings } from '../../../shared/native-chat/native-chat-appearance-settings'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('registerZoomIpcBridge', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  // Test the zoom bridge directly: useIpcEvents adds an unrelated import graph that timed out under parallel load.
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
    vi.doMock('@/components/editor/viewer-zoom-request', () => ({
      requestViewerZoom,
      requestFrontDialogViewerZoom: () => false
    }))
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
})
