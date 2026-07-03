// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { bindTabStripContentResizeObservers } from './tab-strip-content-resize-observers'

describe('bindTabStripContentResizeObservers', () => {
  it('observes the strip and its tab children', () => {
    const onResize = vi.fn()
    const strip = document.createElement('div')
    const firstTab = document.createElement('div')
    const secondTab = document.createElement('div')
    strip.append(firstTab, secondTab)

    const observe = vi.fn()
    const disconnect = vi.fn()
    const resizeObserver = vi.fn(function ResizeObserver(
      this: ResizeObserver,
      callback: ResizeObserverCallback
    ) {
      this.observe = observe
      this.disconnect = disconnect
      callback([], this)
    })

    vi.stubGlobal('ResizeObserver', resizeObserver)

    const disconnectObservers = bindTabStripContentResizeObservers(strip, onResize)

    expect(observe).toHaveBeenCalledWith(strip)
    expect(observe).toHaveBeenCalledWith(firstTab)
    expect(observe).toHaveBeenCalledWith(secondTab)
    expect(onResize).toHaveBeenCalled()

    disconnectObservers()
    expect(disconnect).toHaveBeenCalled()

    vi.unstubAllGlobals()
  })
})
