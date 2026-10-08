import { describe, expect, it, vi } from 'vitest'
import { createWebviewBrowserPageSurface } from './browser-page-webview-surface'

function makeWebview(): Electron.WebviewTag {
  const listeners = new Map<string, EventListener>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements every webview member exercised by the surface adapter.
  return {
    addEventListener: vi.fn((name: string, listener: EventListener) =>
      listeners.set(name, listener)
    ),
    blur: vi.fn(),
    canGoBack: vi.fn(() => true),
    capturePage: vi.fn(async () => ({
      getSize: () => ({ height: 10, width: 20 }),
      isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,AA=='
    })),
    canGoForward: vi.fn(() => false),
    findInPage: vi.fn(),
    focus: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({ height: 20, left: 1, top: 2, width: 30 })),
    getTitle: vi.fn(() => 'Example'),
    getURL: vi.fn(() => 'https://example.test/'),
    getZoomLevel: vi.fn(() => 0),
    goBack: vi.fn(),
    goForward: vi.fn(),
    isLoading: vi.fn(() => false),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    setZoomLevel: vi.fn(),
    stop: vi.fn(),
    stopFindInPage: vi.fn()
  } as unknown as Electron.WebviewTag
}

describe('createWebviewBrowserPageSurface', () => {
  it('reads the current ref for each command after guest replacement', () => {
    const first = makeWebview()
    const second = makeWebview()
    const webviewRef: { current: Electron.WebviewTag | null } = { current: first }
    const surface = createWebviewBrowserPageSurface(webviewRef)

    surface.goBack()
    webviewRef.current = second
    surface.goBack()
    surface.navigate('https://next.test/')

    expect(first.goBack).toHaveBeenCalledOnce()
    expect(second.goBack).toHaveBeenCalledOnce()
    expect(second.src).toBe('https://next.test/')
  })

  it('captures the current guest viewport and stops it', async () => {
    const webview = makeWebview()
    const surface = createWebviewBrowserPageSurface({ current: webview })

    await expect(surface.captureViewport()).resolves.toEqual({
      dataUrl: 'data:image/png;base64,AA==',
      height: 10,
      width: 20
    })
    surface.stop()
    expect(webview.stop).toHaveBeenCalledOnce()
  })

  it('delegates snapshot, zoom, find events and detach safely', () => {
    const webview = makeWebview()
    const webviewRef: { current: Electron.WebviewTag | null } = { current: webview }
    const surface = createWebviewBrowserPageSurface(webviewRef)
    const listener = vi.fn()

    expect(surface.getSnapshot()).toMatchObject({ canGoBack: true, zoomLevel: 0 })
    expect(surface.stepZoom('in')).not.toBeNull()
    expect(webview.setZoomLevel).toHaveBeenCalledOnce()
    const remove = surface.subscribeFindResults(listener)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeWebview installs a vi.fn listener registry.
    const foundListener = (webview.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0][1]
    foundListener({ result: { activeMatchOrdinal: 2, matches: 3 } })
    expect(listener).toHaveBeenCalledWith({ activeMatchOrdinal: 2, matches: 3 })
    remove()

    webviewRef.current = null
    expect(surface.getBounds()).toBeNull()
    expect(surface.focus()).toBe(false)
    expect(() => surface.runFind('needle')).not.toThrow()
  })

  it('rebinds a retained find subscription after old-to-null-to-new guest replacement', () => {
    const first = makeWebview()
    const second = makeWebview()
    const webviewRef: { current: Electron.WebviewTag | null } = { current: first }
    const surface = createWebviewBrowserPageSurface(webviewRef)
    const callback = vi.fn()
    const unsubscribe = surface.subscribeFindResults(callback)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeWebview installs a vi.fn listener registry.
    const firstListener = (first.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0][1]

    webviewRef.current = null
    surface.refresh()
    expect(first.removeEventListener).toHaveBeenCalledWith('found-in-page', firstListener)

    webviewRef.current = second
    surface.refresh()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeWebview installs a vi.fn listener registry.
    const secondListener = (second.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0][1]
    secondListener({ result: { activeMatchOrdinal: 4, matches: 5 } })
    expect(callback).toHaveBeenCalledWith({ activeMatchOrdinal: 4, matches: 5 })

    unsubscribe()
    expect(second.removeEventListener).toHaveBeenCalledWith('found-in-page', secondListener)
  })
})
