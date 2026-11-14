import { describe, expect, it, vi } from 'vitest'
import { createWsOutboundBackpressureQueue } from './ws-outbound-backpressure-queue'

// Inject bufferedAmount and drain scheduling to avoid wall-clock races.

function createHarness(overrides?: {
  softCapBytes?: number
  maxQueuedBytes?: number
  maxQueuedFrames?: number
  parkAfterSend?: boolean
  throwOnSend?: boolean
}) {
  const sent: string[] = []
  let bufferedAmount = 0
  const overflow = vi.fn()
  let pendingTimer: (() => void) | null = null
  let pendingTimerDelay: number | null = null

  const softCapBytes = overrides?.softCapBytes ?? 100
  const queue = createWsOutboundBackpressureQueue<string>({
    send: (frame) => {
      sent.push(frame)
      if (overrides?.throwOnSend) {
        throw new Error('send failed')
      }
      if (overrides?.parkAfterSend) {
        bufferedAmount = softCapBytes + 1
      }
    },
    byteLengthOf: (frame) => frame.length,
    getBufferedAmount: () => bufferedAmount,
    isWritable: () => true,
    onOverflow: overflow,
    softCapBytes,
    maxQueuedBytes: overrides?.maxQueuedBytes ?? 1000,
    maxQueuedFrames: overrides?.maxQueuedFrames,
    drainPollMs: 10,
    setTimer: (cb, delay) => {
      pendingTimer = cb
      pendingTimerDelay = delay
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {
      pendingTimer = null
      pendingTimerDelay = null
    }
  })

  return {
    queue,
    sent,
    overflow,
    setBuffered: (value: number) => {
      bufferedAmount = value
    },
    runTimer: () => {
      const cb = pendingTimer
      pendingTimer = null
      pendingTimerDelay = null
      cb?.()
    },
    hasTimer: () => pendingTimer !== null,
    timerDelay: () => pendingTimerDelay
  }
}

describe('ws outbound backpressure queue', () => {
  it('applies prospective admission to a direct-send frame', () => {
    const sent = vi.fn()
    const canSend = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    let pendingTimer: (() => void) | null = null
    const queue = createWsOutboundBackpressureQueue<string>({
      send: sent,
      byteLengthOf: (frame) => frame.length,
      getBufferedAmount: () => 0,
      isWritable: () => true,
      canSend,
      onOverflow: vi.fn(),
      setTimer: (callback) => {
        pendingTimer = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {
        pendingTimer = null
      }
    })

    expect(queue.enqueue('frame')).toBe(true)

    expect(canSend).toHaveBeenCalledWith(5, false)
    expect(sent).not.toHaveBeenCalled()
    expect(queue.queuedBytes()).toBe(5)

    const scheduled = pendingTimer as (() => void) | null
    scheduled?.()
    expect(canSend).toHaveBeenLastCalledWith(5, true)
    expect(sent).toHaveBeenCalledWith('frame')
    queue.dispose()
  })

  it('parks frames in order while over the cap and drains on recovery without loss', () => {
    const h = createHarness({ softCapBytes: 100 })
    h.setBuffered(200)
    h.queue.enqueue('one')
    h.queue.enqueue('two')
    h.queue.enqueue('three')
    expect(h.sent).toEqual([])
    expect(h.queue.queuedBytes()).toBe('one'.length + 'two'.length + 'three'.length)
    expect(h.timerDelay()).toBe(10)

    h.setBuffered(0)
    h.runTimer()
    expect(h.sent).toEqual(['one', 'two', 'three'])
    expect(h.queue.queuedBytes()).toBe(0)
  })

  it('drops a retained backlog and signals once when a drain send throws', () => {
    const h = createHarness({ softCapBytes: 10, throwOnSend: true })
    h.setBuffered(100)
    const first = h.queue.enqueueCancelable('one')
    h.queue.enqueue('two')

    h.setBuffered(0)
    expect(() => h.runTimer()).not.toThrow()
    expect(h.queue.enqueue('later')).toBe(false)

    expect(h.sent).toEqual(['one'])
    expect(h.overflow).toHaveBeenCalledOnce()
    expect(h.queue.evidence()).toEqual({ queuedBytes: 0, queuedFrames: 0, storageSlots: 0 })
    expect(first.cancel()).toBe(false)
    expect(h.hasTimer()).toBe(false)
  })

  it('keeps ordering when a frame arrives while a backlog is parked', () => {
    const h = createHarness({ softCapBytes: 100 })
    h.setBuffered(200)
    h.queue.enqueue('first')
    h.setBuffered(0)
    // New frames must stay behind existing backlog even when the wire clears.
    h.queue.enqueue('second')
    expect(h.sent).toEqual([])
    h.runTimer()
    expect(h.sent).toEqual(['first', 'second'])
  })

  it('cancels a parked frame and releases its queue capacity before drain', () => {
    const h = createHarness({ softCapBytes: 10, maxQueuedBytes: 8 })
    h.setBuffered(100)
    const cancelled = h.queue.enqueueCancelable('first')

    expect(cancelled).toMatchObject({ accepted: true, queued: true })
    expect(cancelled.cancel()).toBe(true)
    expect(cancelled.cancel()).toBe(false)
    expect(h.queue.evidence()).toMatchObject({ queuedBytes: 0, queuedFrames: 0 })

    h.queue.enqueue('12345678')
    h.setBuffered(0)
    h.runTimer()
    expect(h.sent).toEqual(['12345678'])
  })

  it('signals overflow (and drops backlog) when the hard cap is exceeded', () => {
    const h = createHarness({ softCapBytes: 10, maxQueuedBytes: 8 })
    h.setBuffered(100)
    h.queue.enqueue('12345')
    expect(h.overflow).not.toHaveBeenCalled()
    h.queue.enqueue('67890')
    expect(h.overflow).toHaveBeenCalledTimes(1)
    // Overflow makes the queue inert, with no repeated notification.
    h.setBuffered(0)
    h.runTimer()
    h.queue.enqueue('later')
    expect(h.sent).toEqual([])
    expect(h.overflow).toHaveBeenCalledTimes(1)
  })
})
