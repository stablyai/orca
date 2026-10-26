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
})
