// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { listenForPdfZoomRequests, requestPdfZoom } from './pdf-zoom-request'

describe('requestPdfZoom', () => {
  it('reports whether a PDF took the zoom command', () => {
    expect(requestPdfZoom('in')).toBe(false)

    const onZoom = vi.fn()
    const stop = listenForPdfZoomRequests(onZoom)
    expect(requestPdfZoom('out')).toBe(true)
    expect(onZoom).toHaveBeenCalledWith('out')

    stop()
    expect(requestPdfZoom('reset')).toBe(false)
    expect(onZoom).toHaveBeenCalledTimes(1)
  })
})
