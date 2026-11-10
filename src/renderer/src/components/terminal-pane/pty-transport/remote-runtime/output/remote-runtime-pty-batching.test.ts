import { describe, expect, it, vi } from 'vitest'

import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../../../../shared/clipboard-text'
import {
  createRemoteRuntimePtyTextBatcher,
  createRemoteRuntimeViewportBatcher
} from './remote-runtime-pty-batching'

describe('createRemoteRuntimePtyTextBatcher', () => {
  it('sends idle input at once and coalesces input inside the window', async () => {
    vi.useFakeTimers()
    try {
      const flushes: string[] = []
      const batcher = createRemoteRuntimePtyTextBatcher(10, (text) => flushes.push(text), {
        maxPendingBytes: 8
      })

      expect(batcher.push('a')).toBe(true)
      expect(flushes).toEqual(['a'])
      expect(batcher.push('b')).toBe(true)
      expect(batcher.push('c')).toBe(true)
      expect(flushes).toEqual(['a'])
      // Why: a remount during the window discards these, and the pane must know to say so.
      expect(batcher.hasPendingInput()).toBe(true)

      await vi.advanceTimersByTimeAsync(10)
      expect(flushes).toEqual(['a', 'bc'])
      expect(batcher.hasPendingInput()).toBe(false)

      // The window stays open after a trailing flush; once it lapses idle, the next key goes at once.
      expect(batcher.push('d')).toBe(true)
      expect(flushes).toEqual(['a', 'bc'])
      await vi.advanceTimersByTimeAsync(10)
      expect(flushes).toEqual(['a', 'bc', 'd'])
      await vi.advanceTimersByTimeAsync(10)
      expect(batcher.push('e')).toBe(true)
      expect(flushes).toEqual(['a', 'bc', 'd', 'e'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps idle input trailing while the leading edge is disabled', () => {
    vi.useFakeTimers()
    try {
      const flushes: string[] = []
      const batcher = createRemoteRuntimePtyTextBatcher(10, (text) => flushes.push(text), {
        sendLeadingEdge: () => false
      })

      expect(batcher.push('a')).toBe(true)
      expect(batcher.push('b')).toBe(true)
      expect(flushes).toEqual([])
      vi.advanceTimersByTime(10)
      expect(flushes).toEqual(['ab'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes before pending input exceeds the byte ceiling', () => {
    vi.useFakeTimers()
    try {
      const flushes: string[] = []
      const batcher = createRemoteRuntimePtyTextBatcher(10, (text) => flushes.push(text), {
        maxPendingBytes: 4
      })

      expect(batcher.push('x')).toBe(true)
      expect(batcher.push('ab')).toBe(true)
      expect(batcher.push('cd')).toBe(true)
      expect(flushes).toEqual(['x'])

      expect(batcher.push('e')).toBe(true)
      expect(flushes).toEqual(['x', 'abcd', 'e'])
    } finally {
      vi.useRealTimers()
    }
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

  it('yields while validating large accepted input before sending it', async () => {
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

      expect(flushes).toEqual([text])
      expect(batcher.takePending()).toBe('tail')
    } finally {
      vi.useRealTimers()
    }
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

describe('createRemoteRuntimeViewportBatcher', () => {
  it('drops the queued viewport on clear so a later flush emits nothing', () => {
    vi.useFakeTimers()
    try {
      const resizes: { cols: number; rows: number }[] = []
      const batcher = createRemoteRuntimeViewportBatcher(33, (cols, rows) => {
        resizes.push({ cols, rows })
      })

      batcher.queue(120, 40)
      batcher.clear()
      // A stale pending viewport left behind by clear() would leak out here.
      batcher.flush()

      expect(resizes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not emit a cleared viewport when the debounce timer would have fired', () => {
    vi.useFakeTimers()
    try {
      const resizes: { cols: number; rows: number }[] = []
      const batcher = createRemoteRuntimeViewportBatcher(33, (cols, rows) => {
        resizes.push({ cols, rows })
      })

      batcher.queue(90, 30)
      batcher.clear()
      vi.advanceTimersByTime(100)

      expect(resizes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
