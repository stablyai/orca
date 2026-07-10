import { describe, expect, it, vi } from 'vitest'
import { createWsOutboundBackpressureQueue } from './ws-outbound-backpressure-queue'

// Deterministic harness: bufferedAmount and the drain timer are both injected,
// so no wall-clock races. `runTimers` fires the single parked drain callback.

function createHarness(overrides?: {
  softCapBytes?: number
  maxQueuedBytes?: number
  writable?: boolean
}) {
  const sent: string[] = []
  let bufferedAmount = 0
  let writable = overrides?.writable ?? true
  const overflow = vi.fn()
  let pendingTimer: (() => void) | null = null

  const queue = createWsOutboundBackpressureQueue<string>({
    send: (frame) => sent.push(frame),
    byteLengthOf: (frame) => frame.length,
    getBufferedAmount: () => bufferedAmount,
    isWritable: () => writable,
    onOverflow: overflow,
    softCapBytes: overrides?.softCapBytes ?? 100,
    maxQueuedBytes: overrides?.maxQueuedBytes ?? 1000,
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
