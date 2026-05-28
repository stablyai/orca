import { describe, expect, it, vi } from 'vitest'
import { createDividerFlexFrameScheduler } from './pane-divider'

describe('createDividerFlexFrameScheduler', () => {
  it('coalesces repeated drag updates into one flex write per animation frame', () => {
    const apply = vi.fn()
    const queuedFrames: FrameRequestCallback[] = []
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback)
      return queuedFrames.length
    })
    const cancelFrame = vi.fn()
    const scheduler = createDividerFlexFrameScheduler({ apply, requestFrame, cancelFrame })

    scheduler.schedule(120, 280)
    scheduler.schedule(140, 260)
    scheduler.schedule(160, 240)

    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()

    queuedFrames[0]?.(16)

    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenLastCalledWith(160, 240)
    expect(cancelFrame).not.toHaveBeenCalled()
  })

  it('flushes the latest drag update before final pane refit', () => {
    const apply = vi.fn()
    const requestFrame = vi.fn(() => 7)
    const cancelFrame = vi.fn()
    const scheduler = createDividerFlexFrameScheduler({ apply, requestFrame, cancelFrame })

    scheduler.schedule(120, 280)
    scheduler.schedule(180, 220)
    scheduler.flush()

    expect(cancelFrame).toHaveBeenCalledWith(7)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(180, 220)
  })
})
