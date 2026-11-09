import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueuedPaneResize } from './mounted-pane-fit'

describe('createQueuedPaneResize', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a focus request when a later fit-only resize replaces the frame', () => {
    const frames: (() => void)[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const run = vi.fn()
    const queued = createQueuedPaneResize(run)

    queued.queue(true)
    queued.queue(false)
    frames.at(-1)?.()

    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(true)
  })
})
