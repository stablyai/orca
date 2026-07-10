import { describe, expect, it, vi } from 'vitest'
import {
  waitForStableStartupGrid,
  type TerminalStartupGridDimensions
} from './terminal-startup-grid-settle'

function createFrameScheduler() {
  const queue = new Map<number, () => void>()
  let nextHandle = 1
  return {
    requestFrame: (callback: () => void): number => {
      const handle = nextHandle
      nextHandle += 1
      queue.set(handle, callback)
      return handle
    },
    cancelFrame: (handle: number): void => {
      queue.delete(handle)
    },
    run(maxFrames = 100): number {
      let ran = 0
      while (queue.size > 0 && ran < maxFrames) {
        const [handle, callback] = queue.entries().next().value as [number, () => void]
        queue.delete(handle)
        callback()
        ran += 1
      }
      return ran
    },
    pending: (): number => queue.size
  }
}

function createTimelineMeasure(timeline: (frame: number) => TerminalStartupGridDimensions | null) {
  let frame = 0
  return vi.fn((): TerminalStartupGridDimensions | null => {
    const dimensions = timeline(frame)
    frame += 1
    return dimensions
  })
}

describe('waitForStableStartupGrid', () => {
  it('holds until the cap when the first measured grid stays stable', () => {
    const scheduler = createFrameScheduler()
    const onSettled = vi.fn()
    const measure = createTimelineMeasure(() => ({ cols: 120, rows: 40 }))

    waitForStableStartupGrid({
      isAlive: () => true,
      measure,
      onSettled,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
      minFrames: 4,
      stableFrames: 2,
      maxFrames: 8
    })

    scheduler.run(7)
    expect(onSettled).not.toHaveBeenCalled()

    scheduler.run()
    expect(onSettled).toHaveBeenCalledWith({ cols: 120, rows: 40 })
    expect(measure).toHaveBeenCalledTimes(8)
  })

  it('settles on the later split grid instead of the early wide grid', () => {
    const scheduler = createFrameScheduler()
    const onSettled = vi.fn()
    const measure = createTimelineMeasure((frame) =>
      frame < 5 ? { cols: 180, rows: 50 } : { cols: 88, rows: 50 }
    )

    waitForStableStartupGrid({
      isAlive: () => true,
      measure,
      onSettled,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
      minFrames: 4,
      stableFrames: 2,
      maxFrames: 12
    })

    scheduler.run()

    expect(onSettled).toHaveBeenCalledWith({ cols: 88, rows: 50 })
  })

  it('ignores pre-ready stable grids until an external split gate opens', () => {
    const scheduler = createFrameScheduler()
    const onSettled = vi.fn()
    let ready = false
    const measure = vi.fn(() => (ready ? { cols: 88, rows: 50 } : { cols: 180, rows: 50 }))

    waitForStableStartupGrid({
      isAlive: () => true,
      isReadyToSettle: () => ready,
      measure,
      onSettled,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
      minFrames: 3,
      stableFrames: 2,
      maxFrames: 4
    })

    scheduler.run(8)
    expect(onSettled).not.toHaveBeenCalled()

    ready = true
    scheduler.run()

    expect(onSettled).toHaveBeenCalledWith({ cols: 88, rows: 50 })
  })

  it('uses the latest usable grid at the frame cap when dimensions keep changing', () => {
    const scheduler = createFrameScheduler()
    const onSettled = vi.fn()
    const measure = createTimelineMeasure((frame) => ({ cols: 100 + frame, rows: 30 }))

    waitForStableStartupGrid({
      isAlive: () => true,
      measure,
      onSettled,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
      minFrames: 2,
      stableFrames: 2,
      maxFrames: 5
    })

    scheduler.run()

    expect(onSettled).toHaveBeenCalledWith({ cols: 104, rows: 30 })
  })

  it('settles with null when the pane never becomes measurable', () => {
    const scheduler = createFrameScheduler()
    const onSettled = vi.fn()

    waitForStableStartupGrid({
      isAlive: () => true,
      measure: vi.fn(() => null),
      onSettled,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
      minFrames: 2,
      stableFrames: 2,
      maxFrames: 4
    })

    scheduler.run()

    expect(onSettled).toHaveBeenCalledWith(null)
  })

  it('cancels the pending frame without calling the settle callback', () => {
    const scheduler = createFrameScheduler()
    const onSettled = vi.fn()
    const handle = waitForStableStartupGrid({
      isAlive: () => true,
      measure: vi.fn(() => ({ cols: 120, rows: 40 })),
      onSettled,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame
    })

    handle.cancel()
    scheduler.run()

    expect(scheduler.pending()).toBe(0)
    expect(onSettled).not.toHaveBeenCalled()
  })
})
