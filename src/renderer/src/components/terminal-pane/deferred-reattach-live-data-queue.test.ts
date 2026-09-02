import { describe, expect, it, vi } from 'vitest'
import {
  DeferredReattachLiveDataQueue,
  MAX_DEFERRED_REATTACH_LIVE_CHARS,
  MAX_DEFERRED_REATTACH_LIVE_CHUNKS,
  type DeferredReattachLiveDataChunk
} from './deferred-reattach-live-data-queue'

function createChunk(
  data: string,
  streamGeneration = 1,
  options: Omit<DeferredReattachLiveDataChunk, 'data' | 'streamGeneration'> = {
    ptyId: 'pty-1'
  }
): DeferredReattachLiveDataChunk {
  return { data, streamGeneration, ...options }
}

function releaseTransferred(chunks: DeferredReattachLiveDataChunk[]): void {
  for (const chunk of chunks) {
    chunk.ackCredit?.()
  }
}

class ReferenceDeferredQueue {
  private chunks: DeferredReattachLiveDataChunk[] = []
  private retainedChars = 0

  enqueue(chunk: DeferredReattachLiveDataChunk): void {
    this.chunks = this.chunks.filter((queued) => {
      const keep = queued.streamGeneration === chunk.streamGeneration
      if (!keep) {
        queued.ackCredit?.()
      }
      return keep
    })
    this.retainedChars = this.chunks.reduce((total, queued) => total + queued.data.length, 0)
    const oversized = chunk.data.length > MAX_DEFERRED_REATTACH_LIVE_CHARS
    this.chunks.push({
      ...chunk,
      data: oversized ? chunk.data.slice(-MAX_DEFERRED_REATTACH_LIVE_CHARS) : chunk.data
    })
    this.retainedChars += this.chunks.at(-1)?.data.length ?? 0

    let dropped = oversized
    while (
      this.chunks.length > 1 &&
      (this.chunks.length > MAX_DEFERRED_REATTACH_LIVE_CHUNKS ||
        this.retainedChars > MAX_DEFERRED_REATTACH_LIVE_CHARS)
    ) {
      const removed = this.chunks.shift()
      this.retainedChars -= removed?.data.length ?? 0
      removed?.ackCredit?.()
      dropped = true
    }
    if (dropped && this.chunks[0]) {
      this.chunks[0].meta = { ...this.chunks[0].meta, droppedOutput: true }
    }
  }

  takeAll(): DeferredReattachLiveDataChunk[] {
    const chunks = this.chunks
    this.chunks = []
    this.retainedChars = 0
    return chunks
  }

  discard(): void {
    for (const chunk of this.takeAll()) {
      chunk.ackCredit?.()
    }
  }
}

function normalizedChunks(chunks: DeferredReattachLiveDataChunk[]): unknown[] {
  return chunks.map(({ ackCredit: _ackCredit, ...chunk }) => chunk)
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

describe('deferred reattach live data queue', () => {
  it('does not rescan or shift the live queue while saturated', () => {
    const originalFilter = Array.prototype.filter
    const originalReduce = Array.prototype.reduce
    const originalShift = Array.prototype.shift
    const queue = new DeferredReattachLiveDataQueue()

    try {
      for (const method of ['filter', 'reduce', 'shift'] as const) {
        Object.defineProperty(Array.prototype, method, {
          configurable: true,
          writable: true,
          value() {
            throw new Error(`Array.${method} should not run on enqueue`)
          }
        })
      }
      for (let index = 0; index < MAX_DEFERRED_REATTACH_LIVE_CHUNKS * 2; index += 1) {
        queue.enqueue(createChunk('x'.repeat(512)))
      }
    } finally {
      Object.defineProperties(Array.prototype, {
        filter: { configurable: true, writable: true, value: originalFilter },
        reduce: { configurable: true, writable: true, value: originalReduce },
        shift: { configurable: true, writable: true, value: originalShift }
      })
    }

    expect(queue.takeAll()).toHaveLength(MAX_DEFERRED_REATTACH_LIVE_CHUNKS)
  })

  it('evicts whole chunks only after the count and character boundaries are exceeded', () => {
    const countQueue = new DeferredReattachLiveDataQueue()
    const countAcks = Array.from({ length: MAX_DEFERRED_REATTACH_LIVE_CHUNKS + 1 }, () => vi.fn())
    for (let index = 0; index < MAX_DEFERRED_REATTACH_LIVE_CHUNKS; index += 1) {
      countQueue.enqueue(
        createChunk('', 1, { ptyId: 'pty-1', meta: { seq: index }, ackCredit: countAcks[index] })
      )
    }

    expect(countQueue.getStorageForTest().retainedChunks).toBe(MAX_DEFERRED_REATTACH_LIVE_CHUNKS)
    expect(countAcks.every((ack) => ack.mock.calls.length === 0)).toBe(true)
    countQueue.enqueue(
      createChunk('', 1, {
        ptyId: 'pty-1',
        meta: { seq: MAX_DEFERRED_REATTACH_LIVE_CHUNKS },
        ackCredit: countAcks.at(-1)
      })
    )

    const counted = countQueue.takeAll()
    expect(countAcks[0]).toHaveBeenCalledOnce()
    expect(counted).toHaveLength(MAX_DEFERRED_REATTACH_LIVE_CHUNKS)
    expect(counted[0]?.meta).toEqual({ seq: 1, droppedOutput: true })
    expect(counted.at(-1)?.meta?.seq).toBe(MAX_DEFERRED_REATTACH_LIVE_CHUNKS)
    releaseTransferred(counted)
    expect(countAcks.every((ack) => ack.mock.calls.length === 1)).toBe(true)

    const charQueue = new DeferredReattachLiveDataQueue()
    const fullAck = vi.fn()
    const tailAck = vi.fn()
    charQueue.enqueue(
      createChunk('a'.repeat(MAX_DEFERRED_REATTACH_LIVE_CHARS), 1, {
        ptyId: 'pty-1',
        ackCredit: fullAck
      })
    )
    expect(charQueue.getStorageForTest().retainedChars).toBe(MAX_DEFERRED_REATTACH_LIVE_CHARS)
    charQueue.enqueue(createChunk('tail', 1, { ptyId: 'pty-1', ackCredit: tailAck }))

    const characterBounded = charQueue.takeAll()
    expect(fullAck).toHaveBeenCalledOnce()
    expect(characterBounded.map((chunk) => chunk.data)).toEqual(['tail'])
    expect(characterBounded[0]?.meta).toEqual({ droppedOutput: true })
    expect(tailAck).not.toHaveBeenCalled()
    releaseTransferred(characterBounded)
    expect(tailAck).toHaveBeenCalledOnce()
  })

  it('keeps the exact oversized tail and preserves metadata under the gap marker', () => {
    const queue = new DeferredReattachLiveDataQueue()
    const ackCredit = vi.fn()
    const meta = { seq: 9, rawLength: MAX_DEFERRED_REATTACH_LIVE_CHARS + 1, background: true }
    queue.enqueue(
      createChunk(`P${'T'.repeat(MAX_DEFERRED_REATTACH_LIVE_CHARS)}`, 3, {
        ptyId: 'pty-3',
        meta,
        ackCredit
      })
    )

    const retained = queue.takeAll()
    expect(retained).toHaveLength(1)
    expect(retained[0]?.data).toBe('T'.repeat(MAX_DEFERRED_REATTACH_LIVE_CHARS))
    expect(retained[0]?.meta).toEqual({ ...meta, droppedOutput: true })
    expect(meta).not.toHaveProperty('droppedOutput')
    expect(ackCredit).not.toHaveBeenCalled()
    releaseTransferred(retained)
    expect(ackCredit).toHaveBeenCalledOnce()
  })

  it('releases a replaced generation exactly once without carrying its gap marker forward', () => {
    const queue = new DeferredReattachLiveDataQueue()
    const firstAck = vi.fn()
    const secondAck = vi.fn()
    const thirdAck = vi.fn()
    const replacementAck = vi.fn()
    queue.enqueue(createChunk('a'.repeat(300 * 1024), 4, { ptyId: 'old', ackCredit: firstAck }))
    queue.enqueue(createChunk('b'.repeat(300 * 1024), 4, { ptyId: 'old', ackCredit: secondAck }))
    queue.enqueue(createChunk('c', 4, { ptyId: 'old', ackCredit: thirdAck }))

    expect(firstAck).toHaveBeenCalledOnce()
    queue.enqueue(
      createChunk('replacement', 5, {
        ptyId: 'new',
        meta: { seq: 5, transformed: true },
        ackCredit: replacementAck
      })
    )

    const replacement = queue.takeAll()
    expect(firstAck).toHaveBeenCalledOnce()
    expect(secondAck).toHaveBeenCalledOnce()
    expect(thirdAck).toHaveBeenCalledTimes(1)
    expect(replacement).toHaveLength(1)
    expect(replacement[0]?.data).toBe('replacement')
    expect(replacement[0]?.meta).toEqual({ seq: 5, transformed: true })
    expect(replacementAck).not.toHaveBeenCalled()
    releaseTransferred(replacement)
    expect(replacementAck).toHaveBeenCalledOnce()
  })

  it('compacts a cleared prefix repeatedly while settling every credit once', () => {
    const queue = new DeferredReattachLiveDataQueue()
    const acks = Array.from({ length: 513 }, () => vi.fn())
    const fullChunk = 'x'.repeat(MAX_DEFERRED_REATTACH_LIVE_CHARS)
    for (let index = 0; index < acks.length; index += 1) {
      queue.enqueue(
        createChunk(fullChunk, 1, {
          ptyId: 'pty-1',
          ackCredit: acks[index]
        })
      )
      const storage = queue.getStorageForTest()
      expect(storage.retainedChunks).toBe(1)
      expect(storage.retainedChars).toBe(MAX_DEFERRED_REATTACH_LIVE_CHARS)
      expect(storage.backingLength).toBeLessThanOrEqual(64)
    }

    const retained = queue.takeAll()
    expect(retained).toHaveLength(1)
    releaseTransferred(retained)
    expect(acks.every((ack) => ack.mock.calls.length === 1)).toBe(true)
    expect(queue.getStorageForTest()).toEqual({
      backingLength: 0,
      head: 0,
      retainedChars: 0,
      retainedChunks: 0
    })
  })

  it('transfers credits from takeAll but settles retained credits on discard', () => {
    const queue = new DeferredReattachLiveDataQueue()
    const transferredAcks = [vi.fn(), vi.fn()]
    queue.enqueue(createChunk('first', 1, { ptyId: 'pty-1', ackCredit: transferredAcks[0] }))
    queue.enqueue(createChunk('second', 1, { ptyId: 'pty-1', ackCredit: transferredAcks[1] }))

    const transferred = queue.takeAll()
    expect(transferred.map((chunk) => chunk.data)).toEqual(['first', 'second'])
    expect(transferredAcks.every((ack) => ack.mock.calls.length === 0)).toBe(true)

    const discardedAcks = [vi.fn(), vi.fn()]
    queue.enqueue(createChunk('third', 2, { ptyId: 'pty-2', ackCredit: discardedAcks[0] }))
    queue.enqueue(createChunk('fourth', 2, { ptyId: 'pty-2', ackCredit: discardedAcks[1] }))
    queue.discard()
    queue.discard()
    expect(discardedAcks.every((ack) => ack.mock.calls.length === 1)).toBe(true)
    expect(transferredAcks.every((ack) => ack.mock.calls.length === 0)).toBe(true)
    releaseTransferred(transferred)
    expect(transferredAcks.every((ack) => ack.mock.calls.length === 1)).toBe(true)
  })

  it('matches the previous algorithm across a seeded adversarial stream', () => {
    const queue = new DeferredReattachLiveDataQueue()
    const reference = new ReferenceDeferredQueue()
    const random = createSeededRandom(0x5eedc0de)
    const queueAcks = new Map<number, number>()
    const referenceAcks = new Map<number, number>()
    let generation = 1

    const recordAck =
      (acks: Map<number, number>, index: number): (() => void) =>
      () => {
        acks.set(index, (acks.get(index) ?? 0) + 1)
      }
    for (let index = 0; index < 5_000; index += 1) {
      const value = random()
      if (index > 0 && value % 997 === 0) {
        generation += 1
      }
      const bucket = value % 100
      const length =
        index < 1_500
          ? value % 3
          : bucket < 70
            ? value % 1_025
            : bucket < 90
              ? 4 * 1024
              : bucket < 97
                ? 64 * 1024
                : bucket < 99
                  ? 300 * 1024
                  : MAX_DEFERRED_REATTACH_LIVE_CHARS + 1
      const data = String.fromCharCode(65 + (index % 26)).repeat(length)
      const base = {
        data,
        ptyId: `pty-${generation % 3}`,
        streamGeneration: generation,
        meta: {
          seq: index,
          rawLength: length,
          ...(value % 7 === 0 ? { background: true } : {})
        }
      }
      queue.enqueue({ ...base, ackCredit: recordAck(queueAcks, index) })
      reference.enqueue({ ...base, ackCredit: recordAck(referenceAcks, index) })

      if ((index + 1) % 1_000 !== 0) {
        continue
      }
      if ((index + 1) % 2_000 === 0) {
        queue.discard()
        reference.discard()
      } else {
        const actual = queue.takeAll()
        const expected = reference.takeAll()
        expect(normalizedChunks(actual)).toEqual(normalizedChunks(expected))
        releaseTransferred(actual)
        releaseTransferred(expected)
      }
      expect(queueAcks).toEqual(referenceAcks)
    }

    expect(queueAcks).toEqual(referenceAcks)
    expect([...queueAcks.values()].every((count) => count === 1)).toBe(true)
    expect(queueAcks.size).toBe(5_000)
  })
})
