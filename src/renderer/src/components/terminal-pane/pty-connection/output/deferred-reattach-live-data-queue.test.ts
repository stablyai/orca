import { describe, expect, it, vi } from 'vitest'
import {
  DeferredReattachLiveDataQueue,
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

describe('deferred reattach live data queue', () => {
  it('evicts whole chunks only after the count and character boundaries are exceeded', () => {
    const countQueue = new DeferredReattachLiveDataQueue()
    const countAcks = Array.from({ length: 1_024 + 1 }, () => vi.fn())
    for (let index = 0; index < 1_024; index += 1) {
      countQueue.enqueue(
        createChunk('', 1, { ptyId: 'pty-1', meta: { seq: index }, ackCredit: countAcks[index] })
      )
    }
    expect(countAcks.every((ack) => ack.mock.calls.length === 0)).toBe(true)
    countQueue.enqueue(
      createChunk('', 1, {
        ptyId: 'pty-1',
        meta: { seq: 1_024 },
        ackCredit: countAcks.at(-1)
      })
    )

    const counted = countQueue.takeAll()
    expect(countAcks[0]).toHaveBeenCalledOnce()
    expect(counted).toHaveLength(1_024)
    expect(counted[0]?.meta).toEqual({
      seq: 1,
      droppedOutput: true,
      midEscape: 'unknown'
    })
    expect(counted.at(-1)?.meta?.seq).toBe(1_024)
    releaseTransferred(counted)
    expect(countAcks.every((ack) => ack.mock.calls.length === 1)).toBe(true)

    const charQueue = new DeferredReattachLiveDataQueue()
    const fullAck = vi.fn()
    const tailAck = vi.fn()
    charQueue.enqueue(
      createChunk('a'.repeat(524_288), 1, {
        ptyId: 'pty-1',
        ackCredit: fullAck
      })
    )
    charQueue.enqueue(createChunk('tail', 1, { ptyId: 'pty-1', ackCredit: tailAck }))

    const characterBounded = charQueue.takeAll()
    expect(fullAck).toHaveBeenCalledOnce()
    expect(characterBounded.map((chunk) => chunk.data)).toEqual(['tail'])
    expect(characterBounded[0]?.meta).toEqual({
      droppedOutput: true,
      midEscape: 'unknown'
    })
    expect(tailAck).not.toHaveBeenCalled()
    releaseTransferred(characterBounded)
    expect(tailAck).toHaveBeenCalledOnce()
  })

  it('keeps the exact oversized tail and preserves metadata under the gap marker', () => {
    const queue = new DeferredReattachLiveDataQueue()
    const ackCredit = vi.fn()
    const meta = { seq: 9, rawLength: 524_288 + 1, background: true }
    queue.enqueue(
      createChunk(`P${'T'.repeat(524_288)}`, 3, {
        ptyId: 'pty-3',
        meta,
        ackCredit
      })
    )

    const retained = queue.takeAll()
    expect(retained).toHaveLength(1)
    expect(retained[0]?.data).toBe('T'.repeat(524_288))
    // The kept tail keeps its true raw range: the head chars it lost are no longer counted.
    expect(retained[0]?.meta).toEqual({
      ...meta,
      rawLength: 524_288,
      droppedOutput: true,
      midEscape: 'unknown'
    })
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
})
