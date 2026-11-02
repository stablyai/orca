// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { listenForViewerZoomRequests, requestViewerZoom } from './viewer-zoom-request'

describe('requestViewerZoom', () => {
  it('reports whether a viewer took the zoom command', () => {
    expect(requestViewerZoom('in')).toBe(false)

    const onZoom = vi.fn()
    const rootRef: { current: HTMLElement | null } = { current: document.body }
    const stop = listenForViewerZoomRequests(onZoom, rootRef)
    expect(requestViewerZoom('out')).toBe(true)
    expect(onZoom).toHaveBeenCalledWith('out')

    rootRef.current = null
    expect(requestViewerZoom('in')).toBe(false)
    expect(onZoom).toHaveBeenCalledTimes(1)

    rootRef.current = document.body
    stop()
    expect(requestViewerZoom('reset')).toBe(false)
    expect(onZoom).toHaveBeenCalledTimes(1)
  })

  it('respects popupOnly requests so pane viewers ignore them while popup viewers handle them', () => {
    const onPaneZoom = vi.fn()
    const onPopupZoom = vi.fn()
    const paneRef: { current: HTMLElement | null } = { current: document.body }
    const popupRef: { current: HTMLElement | null } = { current: document.body }

    const stopPane = listenForViewerZoomRequests(onPaneZoom, paneRef, 'pane')
    // Pane viewer ignores popupOnly requests
    expect(requestViewerZoom('in', { popupOnly: true })).toBe(false)
    expect(onPaneZoom).not.toHaveBeenCalled()

    // When popup viewer registers, popupOnly request reaches it
    const stopPopup = listenForViewerZoomRequests(onPopupZoom, popupRef, 'popup')
    expect(requestViewerZoom('in', { popupOnly: true })).toBe(true)
    expect(onPopupZoom).toHaveBeenCalledWith('in')
    expect(onPaneZoom).not.toHaveBeenCalled()

    stopPopup()
    stopPane()
  })
})
