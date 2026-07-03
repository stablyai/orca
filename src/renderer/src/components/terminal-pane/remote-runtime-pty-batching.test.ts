import { describe, expect, it, vi } from 'vitest'

import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import { createRemoteRuntimePtyTextBatcher } from './remote-runtime-pty-batching'

describe('createRemoteRuntimePtyTextBatcher', () => {
  it('coalesces small input until the debounce flush', async () => {
    vi.useFakeTimers()
    try {
      const flushes: string[] = []
      const batcher = createRemoteRuntimePtyTextBatcher(10, (text) => flushes.push(text), {
        maxPendingBytes: 8
      })

      expect(batcher.push('a')).toBe(true)
      expect(batcher.push('b')).toBe(true)
      expect(flushes).toEqual([])

      await vi.advanceTimersByTimeAsync(10)

      expect(flushes).toEqual(['ab'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes before pending input exceeds the byte ceiling', () => {
    const flushes: string[] = []
    const batcher = createRemoteRuntimePtyTextBatcher(10, (text) => flushes.push(text), {
      maxPendingBytes: 4
    })

    expect(batcher.push('ab')).toBe(true)
    expect(batcher.push('cd')).toBe(true)
    expect(flushes).toEqual([])

    expect(batcher.push('e')).toBe(true)

    expect(flushes).toEqual(['abcd'])
    batcher.flush()
    expect(flushes).toEqual(['abcd', 'e'])
  })

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

  it('rejects oversized input without flushing clipboard content', () => {
    const flushes: string[] = []
    const batcher = createRemoteRuntimePtyTextBatcher(10, (text) => flushes.push(text), {
      maxBytes: 4,
      maxPendingBytes: 4
    })

    const secret = ['secret-token-', 'payload'].join('')

    expect(batcher.push(secret)).toBe(false)
    expect(flushes).toEqual([])
  })

  it('yields while validating large accepted input before debounce flushing', async () => {
    vi.useFakeTimers()
    try {
      const flushes: string[] = []
      const text = 'x'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
      const batcher = createRemoteRuntimePtyTextBatcher(10, (value) => flushes.push(value), {
        maxPendingBytes: text.length + 1
      })

      expect(batcher.push(text)).toBe(true)
      expect(flushes).toEqual([])

      const drained = batcher.drain()
      await vi.advanceTimersByTimeAsync(0)
      await drained

      expect(flushes).toEqual([])

      await vi.advanceTimersByTimeAsync(10)

      expect(flushes).toEqual([text])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps input queued after deferred validation in byte order', async () => {
    vi.useFakeTimers()
    try {
      const flushes: string[] = []
      const text = 'x'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
      const batcher = createRemoteRuntimePtyTextBatcher(1_000, (value) => flushes.push(value), {
        maxPendingBytes: text.length + 10
      })

      expect(batcher.push(text)).toBe(true)
      expect(batcher.push('tail')).toBe(true)

      const drained = batcher.drain()
      await vi.advanceTimersByTimeAsync(0)
      await drained

      expect(batcher.takePending()).toBe(`${text}tail`)
      expect(flushes).toEqual([])
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
