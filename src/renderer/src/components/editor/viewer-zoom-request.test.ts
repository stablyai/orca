// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { listenForViewerZoomRequests, requestViewerZoom } from './viewer-zoom-request'

describe('requestViewerZoom', () => {
  it('reports whether a viewer took the zoom command', () => {
    expect(requestViewerZoom('in')).toBe(false)

    const onZoom = vi.fn()
    const stop = listenForViewerZoomRequests(onZoom, { current: document.body })
    expect(requestViewerZoom('out')).toBe(true)
    expect(onZoom).toHaveBeenCalledWith('out')

    stop()
    expect(requestViewerZoom('reset')).toBe(false)
    expect(onZoom).toHaveBeenCalledTimes(1)
  })
})
