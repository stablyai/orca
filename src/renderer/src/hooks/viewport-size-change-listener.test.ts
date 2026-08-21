import { describe, expect, it, vi } from 'vitest'
import { addViewportSizeChangeListener } from './viewport-size-change-listener'

function createViewport(width: number, height: number) {
  const listeners = new Set<() => void>()
  return {
    innerWidth: width,
    innerHeight: height,
    addEventListener: (_type: 'resize', listener: () => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: 'resize', listener: () => void) => {
      listeners.delete(listener)
    },
    resizeTo(nextWidth: number, nextHeight: number) {
      this.innerWidth = nextWidth
      this.innerHeight = nextHeight
      for (const listener of listeners) {
        listener()
      }
    },
    emitResize() {
      for (const listener of listeners) {
        listener()
      }
    },
    get listenerCount() {
      return listeners.size
    }
  }
}

describe('addViewportSizeChangeListener', () => {
  it('runs the callback when the viewport size changes', () => {
    const viewport = createViewport(1024, 768)
    const onChange = vi.fn()
    addViewportSizeChangeListener(onChange, viewport)
    viewport.resizeTo(1024, 900)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  // Why: the reveal reflow nudges the device scale factor, so Chromium fires resize with identical
  // dimensions — dismissing transient UI there closes it on every window restore.
  it('ignores a resize that leaves the dimensions untouched', () => {
    const viewport = createViewport(1024, 768)
    const onChange = vi.fn()
    addViewportSizeChangeListener(onChange, viewport)
    viewport.emitResize()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('still reports a later real change after ignoring a no-op resize', () => {
    const viewport = createViewport(1024, 768)
    const onChange = vi.fn()
    addViewportSizeChangeListener(onChange, viewport)
    viewport.emitResize()
    viewport.resizeTo(800, 768)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('treats each size as the new baseline rather than the original', () => {
    const viewport = createViewport(1024, 768)
    const onChange = vi.fn()
    addViewportSizeChangeListener(onChange, viewport)
    viewport.resizeTo(900, 768)
    viewport.emitResize()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('stops listening once removed', () => {
    const viewport = createViewport(1024, 768)
    const onChange = vi.fn()
    const remove = addViewportSizeChangeListener(onChange, viewport)
    remove()
    expect(viewport.listenerCount).toBe(0)
    viewport.resizeTo(640, 480)
    expect(onChange).not.toHaveBeenCalled()
  })
})
