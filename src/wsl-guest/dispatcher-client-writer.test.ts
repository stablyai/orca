import { describe, expect, it, vi } from 'vitest'
import {
  DispatcherClientWriter,
  type DispatcherWriterLane,
  type SinkWriteSettlement
} from './dispatcher-client-writer'

type AcceptedWrite = {
  data: string
  settle: (result: SinkWriteSettlement) => void
}

class FakeSink {
  readonly accepted: AcceptedWrite[] = []
  readonly drainWaiters: (() => void)[] = []
  writableLength = 0
  highWaterMark = 4096
  saturateNext = false
  closed = false

  write = (data: Buffer, settle: (result: SinkWriteSettlement) => void): boolean | void => {
    this.accepted.push({ data: data.toString(), settle })
    this.writableLength += data.length
    if (this.saturateNext) {
      this.saturateNext = false
      return false
    }
    return true
  }

  drain(): void {
    this.writableLength = 0
    for (const waiter of this.drainWaiters.splice(0)) {
      waiter()
    }
  }
}

function createWriter(
  sink: FakeSink,
  onClosed = vi.fn(),
  producerQueueMaxBytes = 1024
): DispatcherClientWriter {
  return new DispatcherClientWriter(
    sink.write,
    {
      supportsWriteCallback: true,
      writableLength: () => sink.writableLength,
      writableHighWaterMark: () => sink.highWaterMark,
      waitWriteDrain: (callback) => {
        sink.drainWaiters.push(callback)
        return () => {
          const index = sink.drainWaiters.indexOf(callback)
          if (index !== -1) {
            sink.drainWaiters.splice(index, 1)
          }
        }
      },
      close: () => {
        sink.closed = true
      }
    },
    onClosed,
    producerQueueMaxBytes
  )
}

function enqueue(
  writer: DispatcherClientWriter,
  lane: DispatcherWriterLane,
  value: string,
  settled = vi.fn()
): ReturnType<typeof vi.fn> {
  expect(writer.enqueue(lane, () => Buffer.from(value), Buffer.byteLength(value), settled)).toBe(
    true
  )
  return settled
}

describe('DispatcherClientWriter', () => {
  it('accepts write(false) once and stops ordinary writes until drain', () => {
    const sink = new FakeSink()
    const writer = createWriter(sink)
    sink.saturateNext = true

    const firstSettled = enqueue(writer, 'ordinary', 'first')
    enqueue(writer, 'ordinary', 'second')

    expect(sink.accepted.map((write) => write.data)).toEqual(['first'])
    sink.accepted[0].settle({ ok: true })
    expect(firstSettled).toHaveBeenCalledWith({ ok: true })
    expect(sink.accepted.map((write) => write.data)).toEqual(['first'])

    sink.drain()
    expect(sink.accepted.map((write) => write.data)).toEqual(['first', 'second'])
  })

  it('closes on a callback error without settling queued work twice', () => {
    const sink = new FakeSink()
    const onClosed = vi.fn()
    const writer = createWriter(sink, onClosed)
    sink.saturateNext = true

    const firstSettled = enqueue(writer, 'ordinary', 'first')
    const secondSettled = enqueue(writer, 'ordinary', 'second')
    const error = new Error('async write failed')
    sink.accepted[0].settle({ ok: false, error })
    sink.accepted[0].settle({ ok: true })

    expect(firstSettled).toHaveBeenCalledTimes(1)
    expect(firstSettled).toHaveBeenCalledWith({ ok: false, error })
    expect(secondSettled).toHaveBeenCalledTimes(1)
    expect(onClosed).toHaveBeenCalledWith(error)
    expect(sink.closed).toBe(true)
  })

  it('preserves FIFO within lanes and rechecks control before producer work', () => {
    const sink = new FakeSink()
    const writer = createWriter(sink)
    sink.saturateNext = true

    enqueue(writer, 'ordinary', 'blocker')
    enqueue(writer, 'bulk', 'bulk-1')
    enqueue(writer, 'ordinary', 'pty-1')
    enqueue(writer, 'control', 'control-1')
    enqueue(writer, 'ordinary', 'pty-2')
    enqueue(writer, 'control', 'control-2')
    expect(sink.accepted.map((write) => write.data)).toEqual(['blocker'])

    sink.drain()

    expect(sink.accepted.map((write) => write.data)).toEqual([
      'blocker',
      'control-1',
      'control-2',
      'pty-1',
      'pty-2',
      'bulk-1'
    ])
  })

  it('allows one coalesced liveness bypass during a saturated epoch', () => {
    const sink = new FakeSink()
    const writer = createWriter(sink)
    sink.saturateNext = true

    enqueue(writer, 'ordinary', 'ordinary')
    const first = enqueue(writer, 'liveness', 'keepalive-1')
    const replaced = enqueue(writer, 'liveness', 'keepalive-2')
    const latest = enqueue(writer, 'liveness', 'keepalive-3')

    expect(sink.accepted.map((write) => write.data)).toEqual(['ordinary', 'keepalive-1'])
    expect(first).not.toHaveBeenCalled()
    expect(replaced).toHaveBeenCalledOnce()
    expect(replaced).toHaveBeenCalledWith({ ok: true })
    expect(latest).not.toHaveBeenCalled()

    sink.drain()
    expect(sink.accepted.map((write) => write.data)).toEqual([
      'ordinary',
      'keepalive-1',
      'keepalive-3'
    ])
  })

  it('gives queued bulk a turn after four interactive or ordinary writes', () => {
    const sink = new FakeSink()
    const writer = createWriter(sink)
    sink.saturateNext = true

    enqueue(writer, 'ordinary', 'blocker')
    enqueue(writer, 'bulk', 'bulk')
    enqueue(writer, 'interactive', 'interactive-1')
    enqueue(writer, 'ordinary', 'ordinary-1')
    enqueue(writer, 'interactive', 'interactive-2')
    enqueue(writer, 'ordinary', 'ordinary-2')
    enqueue(writer, 'interactive', 'interactive-3')

    sink.drain()

    expect(sink.accepted.map((write) => write.data)).toEqual([
      'blocker',
      'interactive-1',
      'interactive-2',
      'interactive-3',
      'bulk',
      'ordinary-1',
      'ordinary-2'
    ])
  })

  it('gives ordinary and bulk lanes bounded turns under sustained interactive traffic', () => {
    const sink = new FakeSink()
    const writer = createWriter(sink)
    sink.saturateNext = true

    enqueue(writer, 'ordinary', 'blocker')
    enqueue(writer, 'ordinary', 'ordinary')
    enqueue(writer, 'bulk', 'bulk')
    for (let index = 1; index <= 12; index++) {
      enqueue(writer, 'interactive', `interactive-${index}`)
    }

    sink.drain()

    expect(sink.accepted.findIndex((write) => write.data === 'ordinary')).toBeLessThanOrEqual(6)
    expect(sink.accepted.findIndex((write) => write.data === 'bulk')).toBeLessThanOrEqual(5)
  })

  it('settles callback-less saturated writes when drain fires during registration', () => {
    const settled = vi.fn()
    const writer = new DispatcherClientWriter(
      () => false,
      {
        waitWriteDrain: (callback) => callback(),
        writableHighWaterMark: () => 4096
      },
      vi.fn(),
      64
    )

    expect(writer.enqueue('ordinary', () => Buffer.from('accepted'), 8, settled)).toBe(true)
    expect(settled).toHaveBeenCalledExactlyOnceWith({ ok: true })
    expect(writer.retainedProducerBytes).toBe(0)
  })

  it('bounds queued producer bytes after write(false) settles before drain', () => {
    const sink = new FakeSink()
    sink.saturateNext = true
    const writer = createWriter(sink, vi.fn(), 64)

    enqueue(writer, 'ordinary', 'accepted-before-drain')
    sink.accepted[0].settle({ ok: true })

    for (let index = 0; index < 4; index++) {
      expect(writer.enqueue('ordinary', () => Buffer.alloc(16), 16)).toBe(true)
    }
    expect(writer.enqueue('ordinary', () => Buffer.alloc(1), 1)).toBe(false)
    expect(writer.retainedProducerBytes).toBe(64)
    expect(sink.accepted).toHaveLength(1)
    expect(sink.writableLength + writer.retainedProducerBytes).toBeLessThanOrEqual(
      sink.highWaterMark + 64
    )

    sink.drain()
    expect(sink.accepted).toHaveLength(5)
  })

  it('cleans queued and in-flight callbacks once on close', () => {
    const sink = new FakeSink()
    const writer = createWriter(sink)
    sink.saturateNext = true
    const first = enqueue(writer, 'ordinary', 'first')
    const second = enqueue(writer, 'bulk', 'second')

    writer.close()
    sink.drain()
    sink.accepted[0].settle({ ok: true })

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(writer.retainedProducerBytes).toBe(0)
    expect(sink.drainWaiters).toHaveLength(0)
  })

  it('settles the idle fence after accepted writes finish or close cancels them', async () => {
    const sink = new FakeSink()
    const writer = createWriter(sink)
    enqueue(writer, 'ordinary', 'first')
    let idle = false
    const waiting = writer.waitForIdle().then(() => {
      idle = true
    })

    await Promise.resolve()
    expect(idle).toBe(false)
    sink.accepted[0].settle({ ok: true })
    await waiting
    expect(idle).toBe(true)

    enqueue(writer, 'ordinary', 'second')
    const canceled = writer.waitForIdle()
    writer.close()
    await canceled
  })

  it('bounds producer retention and preserves capacity for control', () => {
    const sink = new FakeSink()
    sink.highWaterMark = 4096
    sink.saturateNext = true
    const writer = createWriter(sink, vi.fn(), 2048)

    expect(writer.producerFrameCapacity).toBe(3072)
    expect(writer.enqueue('bulk', () => Buffer.alloc(2048), 2048)).toBe(true)
    expect(writer.enqueue('bulk', () => Buffer.alloc(1), 1)).toBe(false)
    expect(writer.retainedProducerBytes).toBe(2048)
    expect(writer.enqueue('control', () => Buffer.from('cancel'), 6)).toBe(true)

    sink.drain()
    expect(sink.accepted[1].data).toBe('cancel')
  })

  it('enforces the encoded HWM-minus-reserve limit for splittable producers', () => {
    const sink = new FakeSink()
    sink.highWaterMark = 4096
    sink.saturateNext = true
    const writer = createWriter(sink, vi.fn(), 8192)

    expect(writer.producerFrameCapacity).toBe(3072)
    expect(writer.enqueue('bulk', () => Buffer.alloc(3073), 3073)).toBe(false)
    expect(writer.enqueue('bulk', () => Buffer.alloc(3072), 3072)).toBe(true)
  })

  it('admits only one indivisible fixed filesystem frame before drain', () => {
    const sink = new FakeSink()
    sink.highWaterMark = 4096
    sink.saturateNext = true
    const writer = createWriter(sink, vi.fn(), 16_384)
    const oversized = 'x'.repeat(5000)

    expect(writer.producerFrameCapacity).toBe(3072)
    expect(writer.enqueue('fixed-bulk', () => Buffer.from(oversized), 5000)).toBe(true)
    expect(writer.enqueue('fixed-bulk', () => Buffer.from(oversized), 5000)).toBe(false)
    expect(writer.enqueue('control', () => Buffer.from('cancel'), 6)).toBe(true)
    expect(sink.accepted.map((write) => write.data)).toEqual([oversized])

    sink.writableLength = 0
    sink.accepted[0].settle({ ok: true })
    expect(writer.enqueue('fixed-bulk', () => Buffer.from(oversized), 5000)).toBe(false)
    sink.drain()
    expect(sink.accepted.map((write) => write.data)).toEqual([oversized, 'cancel'])
  })

  it('gives independent writers progress when one client stays saturated', () => {
    const slowSink = new FakeSink()
    const fastSink = new FakeSink()
    const slow = createWriter(slowSink)
    const fast = createWriter(fastSink)
    slowSink.saturateNext = true

    enqueue(slow, 'ordinary', 'slow-1')
    enqueue(slow, 'ordinary', 'slow-2')
    enqueue(fast, 'ordinary', 'fast-1')
    enqueue(fast, 'ordinary', 'fast-2')

    expect(slowSink.accepted.map((write) => write.data)).toEqual(['slow-1'])
    expect(fastSink.accepted.map((write) => write.data)).toEqual(['fast-1', 'fast-2'])
  })
})
