import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('registerZoomIpcBridge pinch', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('does not zoom the app again after the chat view handled the pinch', async () => {
    const applyUIZoom = vi.fn()
    const setUI = vi.fn()
    const updateSettings = vi.fn()
    vi.doMock('@/lib/ui-zoom', () => ({ applyUIZoom }))
    vi.doMock('@/lib/zoom-events', () => ({ dispatchZoomLevelChanged: vi.fn() }))
    vi.doMock('@/components/browser-pane/host-guest/browser-page-zoom', () => ({
      dispatchBrowserPageZoom: vi.fn()
    }))
    vi.doMock('@/components/editor/viewer-zoom-request', () => ({
      requestViewerZoom: vi.fn(() => false),
      requestFrontDialogViewerZoom: () => false
    }))
    vi.doMock('../../store', () => ({
      useAppStore: {
        getState: () => ({
          activeView: 'terminal',
          activeTabType: 'terminal',
          editorFontZoomLevel: 0,
          setEditorFontZoomLevel: vi.fn(),
          settings: { terminalFontSize: 13 },
          updateSettings
        })
      }
    }))

    const listenerRef: { current: ((direction: 'in' | 'out' | 'reset') => void) | null } = {
      current: null
    }
    vi.stubGlobal('document', { activeElement: null })
    vi.stubGlobal('window', {
      api: {
        ui: {
          onTerminalZoom: (listener: (direction: 'in' | 'out' | 'reset') => void) => {
            listenerRef.current = listener
            return () => {}
          },
          getZoomLevel: () => 0,
          set: setUI
        }
      }
    })

    const { registerZoomIpcBridge } = await import('./zoom-ipc-bridge')
    registerZoomIpcBridge([])
    const fire = listenerRef.current
    if (!fire) {
      throw new Error('Expected the terminal-zoom listener to be registered')
    }
    const { noteChatWheelPinch } = await import('@/components/native-chat/native-chat-wheel-pinch')
    noteChatWheelPinch()
    fire('in')
    expect(applyUIZoom).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
    expect(setUI).not.toHaveBeenCalled()
  })
})
