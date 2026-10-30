import { describe, expect, it } from 'vitest'
import { createBulkWriteHarness, nextBulkWriteTurn } from './dispatcher-bulk-write-test-harness'

describe('bulk admission and sink settlement', () => {
  it('streams more than four fixed-bulk frames without tripping the teardown watchdog', async () => {
    const harness = createBulkWriteHarness()
    try {
      const sequences = Array.from({ length: 8 }, (_, seq) => seq)
      const completion = Promise.all(
        sequences.map((seq) =>
          harness.dispatcher.notifyBulk('fs.streamChunk', { streamId: 1, seq, data: 'fixed' })
        )
      ).then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error })
      )
      await nextBulkWriteTurn()
      await harness.drain()
      expect(await completion).toEqual({ ok: true })
      expect(harness.frames.filter((frame) => frame.method === 'fs.streamChunk')).toEqual(
        sequences.map((seq) => ({ method: 'fs.streamChunk', seq }))
      )
    } finally {
      harness.dispose()
    }
  })

  it('retires a fixed-bulk retry when a closed writer settles it before its client closes', async () => {
    const harness = createBulkWriteHarness(2048, 800)
    try {
      expect(harness.fillProducerQueue()).toBeGreaterThan(1000)
      const completion = harness.dispatcher.notifyBulk('fs.streamChunk', {
        streamId: 1,
        data: 'fixed'
      })
      const assertion = expect(completion).rejects.toThrow('Relay writer is closed')
      await nextBulkWriteTurn()
      expect(harness.dispatcher.capacityRetryCount).toBe(1)
      expect(harness.dispatcher.fixedBulkAdmissions).toEqual([])
      expect(harness.frames).toEqual([{ method: 'pty.data' }])
      expect(harness.pending).toHaveLength(1)
      harness.sink.destroy(new Error('stream destroyed'))
      await nextBulkWriteTurn()
      const pendingWrite = harness.pending.shift()
      if (!pendingWrite) {
        throw new Error('Expected the native writable callback to remain pending')
      }
      pendingWrite.complete(new Error('pending native write failed'))
      await assertion
      expect(harness.sink.writableLength).toBe(0)
      expect(harness.dispatcher.fixedBulkAdmissions).toEqual([
        {
          clientClosed: false,
          writerCanAdmitZero: false,
          retainedProducerBytes: 0,
          settledBeforeReturn: true,
          accepted: false
        }
      ])
      expect(harness.dispatcher.capacityRetryCount).toBe(0)
      expect(harness.dispatcher.retainedPublicationBytes).toBe(0)
    } finally {
      harness.dispose()
    }
  })

  it('ignores a captured capacity retry after its frame is admitted', async () => {
    const harness = createBulkWriteHarness()
    try {
      harness.fillProducerQueue()
      const completion = harness.dispatcher.notifyBulk('git.responseChunk', {
        streamId: 1,
        seq: 0,
        data: 'g'.repeat(40 * 1024)
      })
      await nextBulkWriteTurn()
      const retry = harness.dispatcher.lastCapacityRetry
      if (!retry) {
        throw new Error('Expected a capacity-blocked retry')
      }
      await harness.reachBulk('git.responseChunk')
      expect(harness.dispatcher.capacityRetryCount).toBe(0)
      retry()
      await harness.drain()
      await completion
      expect(harness.frames.filter((frame) => frame.method === 'git.responseChunk')).toEqual([
        { method: 'git.responseChunk', seq: 0 }
      ])
    } finally {
      harness.dispose()
    }
  })

  it('sends a capacity-blocked frame once and advances the client chain after its callback', async () => {
    const harness = createBulkWriteHarness()
    try {
      expect(harness.fillProducerQueue()).toBeGreaterThan(0)
      let firstSettled = false
      const first = harness.dispatcher
        .notifyBulk('git.responseChunk', { streamId: 1, seq: 0, data: 'g'.repeat(40 * 1024) })
        .then(() => {
          firstSettled = true
        })
      const second = harness.dispatcher.notifyBulk('git.responseChunk', {
        streamId: 1,
        seq: 1,
        data: 'following'
      })
      await nextBulkWriteTurn()
      await harness.reachBulk('git.responseChunk')
      expect(firstSettled).toBe(false)
      expect(harness.frames.some((frame) => frame.seq === 1)).toBe(false)
      await harness.releaseOne()
      await harness.drain()
      await Promise.all([first, second])
      expect(harness.frames.filter((frame) => frame.method === 'git.responseChunk')).toEqual([
        { method: 'git.responseChunk', seq: 0 },
        { method: 'git.responseChunk', seq: 1 }
      ])
    } finally {
      harness.dispose()
    }
  })

  it('preserves the admitted frame’s sink failure', async () => {
    const harness = createBulkWriteHarness()
    try {
      const error = new Error('owned sink failure')
      const result = harness.dispatcher.notifyBulk('git.responseChunk', { streamId: 1, seq: 0 })
      const assertion = expect(result).rejects.toBe(error)
      await nextBulkWriteTurn()
      await harness.releaseOne(error)
      await assertion
    } finally {
      harness.dispose()
    }
  })

  it('settles disposal while an admitted bulk frame awaits its callback', async () => {
    const harness = createBulkWriteHarness()
    try {
      let settled = false
      const result = harness.dispatcher
        .notifyBulk('git.responseChunk', { streamId: 1, seq: 0 })
        .then(() => {
          settled = true
        })
      await nextBulkWriteTurn()
      expect(settled).toBe(false)
      harness.dispatcher.dispose()
      await result
      expect(settled).toBe(true)
    } finally {
      harness.dispose()
    }
  })

  it('keeps fixed bulk behind retained producers and sends it once', async () => {
    const harness = createBulkWriteHarness()
    try {
      const producerFrames = harness.fillProducerQueue()
      let settled = false
      const result = harness.dispatcher
        .notifyBulk('fs.streamChunk', { streamId: 1, data: 'fixed' })
        .then(() => {
          settled = true
        })
      await nextBulkWriteTurn()
      expect(harness.frames.some((frame) => frame.method === 'fs.streamChunk')).toBe(false)
      await harness.reachBulk('fs.streamChunk')
      expect(harness.frames.filter((frame) => frame.method === 'pty.data')).toHaveLength(
        producerFrames
      )
      expect(settled).toBe(false)
      await harness.releaseOne()
      await result
      expect(harness.frames.filter((frame) => frame.method === 'fs.streamChunk')).toEqual([
        { method: 'fs.streamChunk' }
      ])
    } finally {
      harness.dispose()
    }
  })
})
