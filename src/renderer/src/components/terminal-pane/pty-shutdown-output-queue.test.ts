import { describe, expect, it } from 'vitest'
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from '../../../../shared/terminal-scrollback-limits'
import { clampUtf8Tail } from './pty-eager-buffer-clamp'
import { PtyShutdownOutputQueue, type PtyShutdownOutputEvent } from './pty-shutdown-output-queue'

const BYTE_LIMIT = TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT
const CHUNK_SIZE = 64

class ReferenceShutdownOutputQueue {
  private events: PtyShutdownOutputEvent[] = []
  private retainedBytes = 0
  private readonly encoder = new TextEncoder()

  enqueue(event: PtyShutdownOutputEvent): void {
    const clamped = clampUtf8Tail(event.data, BYTE_LIMIT)
    this.events.push({ ...event, data: clamped.data })
    this.retainedBytes += clamped.bytes
    while (this.retainedBytes > BYTE_LIMIT && this.events.length > 1) {
      this.retainedBytes -= this.encoder.encode(this.events.shift()?.data ?? '').byteLength
    }
  }

  takeAll(): PtyShutdownOutputEvent[] {
    const events = this.events
    this.events = []
    this.retainedBytes = 0
    return events
  }
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}

function createDifferentialData(value: number): string {
  const bucket = value % 100
  if (bucket < 8) {
    return ''
  }
  if (bucket < 48) {
    return String.fromCharCode(65 + (value % 26)).repeat(value % 513)
  }
  if (bucket < 70) {
    return '界'.repeat(value % 257)
  }
  if (bucket < 88) {
    return '😀'.repeat(value % 129)
  }
  if (bucket < 96) {
    return `\ud800${'x'.repeat(value % 511)}`
  }
  return String.fromCharCode(65 + (value % 26)).repeat(64 * 1024)
}

describe('PTY shutdown output queue', () => {
  it('does not shift or re-encode retained events while saturated', () => {
    const originalShift = Array.prototype.shift
    const originalEncode = TextEncoder.prototype.encode
    const queue = new PtyShutdownOutputQueue()

    try {
      Object.defineProperties(Array.prototype, {
        shift: {
          configurable: true,
          writable: true,
          value() {
            throw new Error('Array.shift should not run on enqueue')
          }
        }
      })
      Object.defineProperties(TextEncoder.prototype, {
        encode: {
          configurable: true,
          writable: true,
          value() {
            throw new Error('TextEncoder.encode should not run on enqueue')
          }
        }
      })
      for (let index = 0; index < 1_536; index += 1) {
        queue.enqueue({ kind: 'data', data: 'x'.repeat(1_024), meta: { seq: index } })
      }
    } finally {
      Object.defineProperties(Array.prototype, {
        shift: { configurable: true, writable: true, value: originalShift }
      })
      Object.defineProperties(TextEncoder.prototype, {
        encode: { configurable: true, writable: true, value: originalEncode }
      })
    }

    expect(queue.takeAll()).toHaveLength(512)
  })

  it('keeps exact UTF-8 boundaries, Unicode tails, and metadata identity', () => {
    const boundaryQueue = new PtyShutdownOutputQueue()
    const emptyMeta = { rawLength: 9, transformed: true, droppedOutput: true }
    boundaryQueue.enqueue({ kind: 'replay', data: 'a'.repeat(BYTE_LIMIT) })
    boundaryQueue.enqueue({ kind: 'data', data: '', meta: emptyMeta })
    expect(boundaryQueue.getStorageForTest()).toMatchObject({
      retainedBytes: BYTE_LIMIT,
      retainedEvents: 2
    })
    boundaryQueue.enqueue({ kind: 'replay', data: 'b' })

    const boundary = boundaryQueue.takeAll()
    expect(boundary).toEqual([
      { kind: 'data', data: '', meta: emptyMeta },
      { kind: 'replay', data: 'b' }
    ])
    expect(boundary[0]?.kind === 'data' ? boundary[0].meta : undefined).toBe(emptyMeta)

    const unicodeQueue = new PtyShutdownOutputQueue()
    const emojiTail = '😀'.repeat(BYTE_LIMIT / 4)
    const unicodeMeta = { seq: 7, rawLength: emojiTail.length + 1, background: true }
    unicodeQueue.enqueue({ kind: 'data', data: `P${emojiTail}`, meta: unicodeMeta })
    const [unicode] = unicodeQueue.takeAll()
    expect(unicode?.data).toBe(emojiTail)
    expect(unicode?.kind === 'data' ? unicode.meta : undefined).toBe(unicodeMeta)

    const loneSurrogateQueue = new PtyShutdownOutputQueue()
    const loneSurrogateTail = `\ud800${'z'.repeat(BYTE_LIMIT - 3)}`
    loneSurrogateQueue.enqueue({ kind: 'replay', data: `P${loneSurrogateTail}` })
    expect(loneSurrogateQueue.takeAll()[0]?.data).toBe(loneSurrogateTail)
  })

  it('evicts whole oldest events without merging replay and live boundaries', () => {
    const queue = new PtyShutdownOutputQueue()
    const meta = { seq: 42, rawLength: BYTE_LIMIT - 3, transformed: true }
    queue.enqueue({ kind: 'replay', data: 'old' })
    queue.enqueue({ kind: 'data', data: 'x'.repeat(BYTE_LIMIT - 3), meta })
    queue.enqueue({ kind: 'replay', data: 'new' })

    const retained = queue.takeAll()
    expect(retained).toEqual([
      { kind: 'data', data: 'x'.repeat(BYTE_LIMIT - 3), meta },
      { kind: 'replay', data: 'new' }
    ])
    expect(retained[0]?.kind === 'data' ? retained[0].meta : undefined).toBe(meta)
  })

  it('retains zero-byte event boundaries without imposing a count cap', () => {
    const queue = new PtyShutdownOutputQueue()
    for (let index = 0; index < 4_097; index += 1) {
      queue.enqueue({ kind: 'data', data: '', meta: { seq: index, transformed: true } })
    }

    expect(queue.getStorageForTest()).toMatchObject({
      retainedBytes: 0,
      retainedEvents: 4_097
    })
    const retained = queue.takeAll()
    expect(retained).toHaveLength(4_097)
    expect(retained[0]).toEqual({ kind: 'data', data: '', meta: { seq: 0, transformed: true } })
    expect(retained.at(-1)).toEqual({
      kind: 'data',
      data: '',
      meta: { seq: 4_096, transformed: true }
    })
  })

  it('repeatedly compacts cleared prefixes and resets transferred storage', () => {
    const queue = new PtyShutdownOutputQueue()
    const fullEvent = '界'.repeat(Math.floor(BYTE_LIMIT / 3))
    for (let index = 0; index < 513; index += 1) {
      queue.enqueue({ kind: 'replay', data: fullEvent })
      const storage = queue.getStorageForTest()
      expect(storage.retainedEvents).toBe(1)
      expect(storage.retainedBytes).toBe(BYTE_LIMIT - 2)
      expect(storage.backingLength).toBeLessThanOrEqual(CHUNK_SIZE)
      expect(storage.byteBackingLength).toBeLessThanOrEqual(CHUNK_SIZE)
    }

    expect(queue.takeAll()).toEqual([{ kind: 'replay', data: fullEvent }])
    expect(queue.getStorageForTest()).toEqual({
      backingLength: 0,
      byteBackingLength: 0,
      chunkBackingLength: 0,
      head: 0,
      headChunk: 0,
      retainedBytes: 0,
      retainedEvents: 0
    })

    queue.enqueue({ kind: 'data', data: 'discarded' })
    queue.discard()
    expect(queue.takeAll()).toEqual([])
  })

  it('releases dead backing storage under release-scale one-byte churn', () => {
    const queue = new PtyShutdownOutputQueue()
    for (let index = 0; index < BYTE_LIMIT + CHUNK_SIZE * 3 + 17; index += 1) {
      queue.enqueue({ kind: 'replay', data: 'x' })
    }

    const storage = queue.getStorageForTest()
    expect(storage.retainedEvents).toBe(BYTE_LIMIT)
    expect(storage.retainedBytes).toBe(BYTE_LIMIT)
    expect(storage.backingLength - storage.retainedEvents).toBeLessThan(CHUNK_SIZE)
    expect(storage.byteBackingLength).toBe(0)
    expect(storage.head).toBeLessThan(CHUNK_SIZE)
    expect(storage.headChunk).toBeLessThan(storage.chunkBackingLength)
  })

  it('repeatedly compacts the consumed chunk cursor', () => {
    const queue = new PtyShutdownOutputQueue()
    const data = 'x'.repeat(BYTE_LIMIT / CHUNK_SIZE)
    for (let index = 0; index < CHUNK_SIZE; index += 1) {
      queue.enqueue({ kind: 'replay', data })
    }

    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (let index = 0; index < CHUNK_SIZE * CHUNK_SIZE; index += 1) {
        queue.enqueue({ kind: 'replay', data })
      }
      expect(queue.getStorageForTest()).toEqual({
        backingLength: CHUNK_SIZE,
        byteBackingLength: 0,
        chunkBackingLength: 1,
        head: 0,
        headChunk: 0,
        retainedBytes: BYTE_LIMIT,
        retainedEvents: CHUNK_SIZE
      })
    }
  })

  it('recounts a returned Unicode event after mutation and re-enqueue', () => {
    const queue = new PtyShutdownOutputQueue()
    const reference = new ReferenceShutdownOutputQueue()
    const unicode: PtyShutdownOutputEvent = { kind: 'replay', data: '界' }
    queue.enqueue(unicode)
    reference.enqueue(unicode)
    const returned = queue.takeAll()[0]
    const referenceReturned = reference.takeAll()[0]
    if (!returned || !referenceReturned) {
      throw new Error('Expected queued events')
    }
    returned.data = 'x'
    referenceReturned.data = 'x'
    queue.enqueue(returned)
    reference.enqueue(referenceReturned)
    const newest: PtyShutdownOutputEvent = { kind: 'data', data: 'y'.repeat(BYTE_LIMIT) }
    queue.enqueue(newest)
    reference.enqueue(newest)
    expect(queue.getStorageForTest().retainedBytes).toBe(BYTE_LIMIT)
    const overflow: PtyShutdownOutputEvent = { kind: 'replay', data: 'z' }
    queue.enqueue(overflow)
    reference.enqueue(overflow)

    expect(queue.takeAll()).toEqual(reference.takeAll())
  })

  it('matches the previous algorithm across a seeded adversarial stream', () => {
    const queue = new PtyShutdownOutputQueue()
    const reference = new ReferenceShutdownOutputQueue()
    const random = createSeededRandom(0x15c0ffee)

    for (let index = 0; index < 5_000; index += 1) {
      const value = random()
      const data = createDifferentialData(value)
      const event: PtyShutdownOutputEvent =
        value % 3 === 0
          ? { kind: 'replay', data }
          : {
              kind: 'data',
              data,
              meta: {
                seq: index,
                rawLength: data.length + (value % 5),
                transformed: value % 2 === 0,
                ...(value % 7 === 0 ? { background: true } : {}),
                ...(value % 97 === 0 ? { droppedOutput: true } : {})
              }
            }
      queue.enqueue(event)
      reference.enqueue(event)

      if ((index + 1) % 1_000 === 0) {
        expect(queue.takeAll()).toEqual(reference.takeAll())
      }
    }
  })
})
