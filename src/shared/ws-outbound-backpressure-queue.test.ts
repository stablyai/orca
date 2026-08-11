import { describe, expect, it, vi } from 'vitest'
import { createWsOutboundBackpressureQueue } from './ws-outbound-backpressure-queue'

// Deterministic harness: bufferedAmount and the drain timer are both injected,
// so no wall-clock races. `runTimers` fires the single parked drain callback.

function createHarness(overrides?: {
  softCapBytes?: number
  maxQueuedBytes?: number
  maxQueuedFrames?: number
  writable?: boolean
  parkAfterSend?: boolean
  throwOnSend?: boolean
}) {
  const sent: string[] = []
  let bufferedAmount = 0
  let writable = overrides?.writable ?? true
  const overflow = vi.fn()
  let pendingTimer: (() => void) | null = null

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
    isWritable: () => writable,
    onOverflow: overflow,
    softCapBytes,
    maxQueuedBytes: overrides?.maxQueuedBytes ?? 1000,
    maxQueuedFrames: overrides?.maxQueuedFrames,
    drainPollMs: 10,
    setTimer: (cb) => {
      pendingTimer = cb
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {
      pendingTimer = null
    }
  })

  return {
    queue,
    sent,
    overflow,
    setBuffered: (value: number) => {
      bufferedAmount = value
    },
    setWritable: (value: boolean) => {
      writable = value
    },
    runTimer: () => {
      const cb = pendingTimer
      pendingTimer = null
      cb?.()
    },
    hasTimer: () => pendingTimer !== null
  }
}

describe('ws outbound backpressure queue', () => {
  it('sends straight through while under the soft cap', () => {
    const h = createHarness()
    h.queue.enqueue('a')
    h.queue.enqueue('b')
    expect(h.sent).toEqual(['a', 'b'])
    expect(h.hasTimer()).toBe(false)
  })

  it('turns an immediate send exception into one overflow signal', () => {
    const h = createHarness({ throwOnSend: true })

    expect(() => h.queue.enqueue('frame')).not.toThrow()
    expect(h.queue.enqueue('later')).toBe(false)

    expect(h.sent).toEqual(['frame'])
    expect(h.overflow).toHaveBeenCalledOnce()
    expect(h.queue.evidence()).toEqual({ queuedBytes: 0, queuedFrames: 0, storageSlots: 0 })
    expect(h.hasTimer()).toBe(false)
  })

  it('applies prospective admission to a direct-send frame', () => {
    const sent = vi.fn()
    const canSend = vi.fn(() => false)
    const queue = createWsOutboundBackpressureQueue<string>({
      send: sent,
      byteLengthOf: (frame) => frame.length,
      getBufferedAmount: () => 0,
      isWritable: () => true,
      canSend,
      onOverflow: vi.fn()
    })

    expect(queue.enqueue('frame')).toBe(true)

    expect(canSend).toHaveBeenCalledWith(5)
    expect(sent).not.toHaveBeenCalled()
    expect(queue.queuedBytes()).toBe(5)
    queue.dispose()
  })

  it('rejects an oversized frame before the direct-send fast path', () => {
    const send = vi.fn()
    const overflow = vi.fn()
    const queue = createWsOutboundBackpressureQueue<string>({
      send,
      byteLengthOf: (frame) => frame.length,
      getBufferedAmount: () => 0,
      isWritable: () => true,
      onOverflow: overflow,
      maxFrameBytes: 4
    })

    expect(queue.enqueue('12345')).toBe(false)

    expect(send).not.toHaveBeenCalled()
    expect(overflow).toHaveBeenCalledOnce()
  })

  it('parks frames in order while over the cap and drains on recovery without loss', () => {
    const h = createHarness({ softCapBytes: 100 })
    h.setBuffered(200) // over cap
    h.queue.enqueue('one')
    h.queue.enqueue('two')
    h.queue.enqueue('three')
    // Nothing sent yet; all held in order.
    expect(h.sent).toEqual([])
    expect(h.queue.queuedBytes()).toBe('one'.length + 'two'.length + 'three'.length)

    // Link recovers; the drain timer flushes everything in FIFO order.
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
    // Even though the wire is now clear, an existing backlog means the new
    // frame must queue behind it, not jump the line.
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

  it('cannot cancel a frame after it has reached the wire', () => {
    const h = createHarness()
    const direct = h.queue.enqueueCancelable('direct')

    expect(direct).toMatchObject({ accepted: true, queued: false })
    expect(direct.cancel()).toBe(false)
    expect(h.sent).toEqual(['direct'])
  })

  it('does not retain sent frame slots while a steady backlog keeps the queue busy', () => {
    const h = createHarness({ softCapBytes: 10, parkAfterSend: true })
    h.setBuffered(100)
    h.queue.enqueue('frame-0')
    h.queue.enqueue('frame-1')

    for (let index = 2; index < 256; index += 1) {
      h.setBuffered(0)
      h.runTimer()
      h.queue.enqueue(`frame-${index}`)
      expect(h.queue.evidence().storageSlots).toBeLessThanOrEqual(66)
    }

    expect(h.sent).toHaveLength(254)
    expect(h.queue.evidence()).toMatchObject({ queuedFrames: 2 })
  })

  it('releases aggregate queue claims on drain, disposal, and denied admission', () => {
    let claimedBytes = 0
    let denyClaims = false
    const overflow = vi.fn()
    let bufferedAmount = 100
    let pendingTimer: (() => void) | null = null
    const sent: string[] = []
    const queue = createWsOutboundBackpressureQueue<string>({
      send: (frame) => sent.push(frame),
      byteLengthOf: (frame) => frame.length,
      getBufferedAmount: () => bufferedAmount,
      isWritable: () => true,
      onOverflow: overflow,
      softCapBytes: 10,
      setTimer: (callback) => {
        pendingTimer = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {
        pendingTimer = null
      },
      claimQueuedBytes: (bytes) => {
        if (denyClaims) {
          return null
        }
        claimedBytes += bytes
        return () => {
          claimedBytes -= bytes
        }
      }
    })

    queue.enqueue('one')
    expect(claimedBytes).toBe(3)
    bufferedAmount = 0
    const runTimer = (): void => {
      const callback = pendingTimer
      pendingTimer = null
      callback?.()
    }
    runTimer()
    expect(sent).toEqual(['one'])
    expect(claimedBytes).toBe(0)

    bufferedAmount = 100
    queue.enqueue('two')
    expect(claimedBytes).toBe(3)
    denyClaims = true
    queue.enqueue('denied')
    expect(overflow).toHaveBeenCalledOnce()
    expect(claimedBytes).toBe(0)
    queue.dispose()
    expect(claimedBytes).toBe(0)
  })

  it('signals overflow (and drops backlog) when the hard cap is exceeded', () => {
    const h = createHarness({ softCapBytes: 10, maxQueuedBytes: 8 })
    h.setBuffered(100) // over soft cap: everything queues
    h.queue.enqueue('12345') // 5 bytes queued
    expect(h.overflow).not.toHaveBeenCalled()
    h.queue.enqueue('67890') // 10 bytes total > 8 -> overflow
    expect(h.overflow).toHaveBeenCalledTimes(1)
    // After overflow the queue is inert: no sends, no further overflow calls.
    h.setBuffered(0)
    h.runTimer()
    h.queue.enqueue('later')
    expect(h.sent).toEqual([])
    expect(h.overflow).toHaveBeenCalledTimes(1)
  })

  it('bounds zero-byte frames independently of the queued-byte cap', () => {
    const h = createHarness({ softCapBytes: 10, maxQueuedFrames: 2 })
    h.setBuffered(100)

    h.queue.enqueue('')
    h.queue.enqueue('')
    h.queue.enqueue('')

    expect(h.overflow).toHaveBeenCalledOnce()
    expect(h.queue.evidence()).toMatchObject({ queuedBytes: 0, queuedFrames: 0 })
  })

  it('fails closed when a caller reports an invalid retained size', () => {
    const overflow = vi.fn()
    const queue = createWsOutboundBackpressureQueue<string>({
      send: vi.fn(),
      byteLengthOf: () => Number.NaN,
      getBufferedAmount: () => 100,
      isWritable: () => true,
      onOverflow: overflow,
      softCapBytes: 10
    })

    queue.enqueue('frame')

    expect(overflow).toHaveBeenCalledOnce()
    expect(queue.evidence()).toMatchObject({ queuedBytes: 0, queuedFrames: 0 })
  })

  it('drops the backlog if the socket becomes unwritable mid-park', () => {
    const h = createHarness({ softCapBytes: 10 })
    h.setBuffered(100)
    h.queue.enqueue('data')
    h.setWritable(false)
    h.runTimer()
    expect(h.sent).toEqual([])
    expect(h.queue.queuedBytes()).toBe(0)
  })

  it('does not fast-path a frame while the socket is unwritable', () => {
    const h = createHarness({ writable: false })

    h.queue.enqueue('data')

    expect(h.sent).toEqual([])
    expect(h.queue.queuedBytes()).toBe('data'.length)
    expect(h.hasTimer()).toBe(true)
  })
})
