import { describe, expect, it, vi } from 'vitest'

import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../../../../shared/clipboard-text'
import { createRemoteRuntimePtyTextBatcher } from './remote-runtime-pty-batching'

describe('createRemoteRuntimePtyTextBatcher', () => {
  it('splits one large UTF-8 input without splitting a code point', () => {
    const flushes: string[] = []
    const batcher = createRemoteRuntimePtyTextBatcher(10, (text) => flushes.push(text), {
      maxPendingBytes: 4
    })

    expect(batcher.push('ab😀cd')).toBe(true)

    expect(flushes).toEqual(['ab', '😀'])
    batcher.flush()
    expect(flushes).toEqual(['ab', '😀', 'cd'])
  })

  it('runs a validation barrier before input queued after it', async () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      const text = 'x'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
      const batcher = createRemoteRuntimePtyTextBatcher(1_000, (value) => events.push(value), {
        maxPendingBytes: text.length + 10
      })

      expect(batcher.push(text)).toBe(true)
      batcher.enqueueAfterValidation(() => {
        const pending = batcher.takePending()
        if (pending) {
          events.push(pending)
        }
        events.push('reply')
      })
      expect(batcher.push('tail')).toBe(true)

      const drained = batcher.drain()
      await vi.advanceTimersByTimeAsync(0)
      await drained
      batcher.flush()

      expect(events).toEqual([text, 'reply', 'tail'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops asynchronously oversized input without flushing clipboard content', async () => {
    vi.useFakeTimers()
    try {
      const flushes: string[] = []
      const text = '😀'.repeat(Math.floor(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS / 2) + 1)
      const batcher = createRemoteRuntimePtyTextBatcher(10, (value) => flushes.push(value), {
        maxBytes: text.length + 1,
        maxPendingBytes: text.length + 1
      })

      expect(batcher.push(text)).toBe(true)

      const drained = batcher.drain()
      await vi.advanceTimersByTimeAsync(0)
      await drained
      batcher.flush()

      expect(flushes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
