// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUFFERED_FINAL_CHARS_PER_SECOND, StreamingTextFrameQueue } from './streaming-text-frame-queue'

afterEach(() => vi.restoreAllMocks())

describe('StreamingTextFrameQueue', () => {
  it('reveals at most 24 characters per target and frame', () => {
    const clock = frameClock()
    const flushed: string[] = []
    const queue = new StreamingTextFrameQueue((deltas) =>
      flushed.push(...deltas.map((delta) => delta.text))
    )

    queue.enqueue({ scopeId: 'c', messageId: 'm', blockIndex: 0 }, 'x'.repeat(60))
    clock.tick()
    clock.tick()
    clock.tick()

    expect(flushed.map((text) => text.length)).toEqual([24, 24, 12])
  })

  it('drains before completion in at most eight frames', () => {
    const clock = frameClock()
    const flushed: number[] = []
    const completed = vi.fn()
    const queue = new StreamingTextFrameQueue((deltas) =>
      flushed.push(...deltas.map((delta) => delta.text.length))
    )

    queue.enqueue({ scopeId: 'c', messageId: 'm', blockIndex: 0 }, 'x'.repeat(24))
    clock.tick()
    flushed.length = 0
    queue.enqueue({ scopeId: 'c', messageId: 'm', blockIndex: 0 }, 'x'.repeat(240))
    expect(queue.drainBefore(completed)).toBe(true)
    for (let index = 0; index < 8; index += 1) {
      clock.tick()
    }

    expect(flushed).toHaveLength(8)
    expect(flushed.reduce((total, length) => total + length, 0)).toBe(240)
    expect(completed).toHaveBeenCalledOnce()
  })

  it('reveals a fully buffered answer at the normal frame rate', () => {
    const clock = frameClock()
    const flushed: number[] = []
    const completed = vi.fn()
    const queue = new StreamingTextFrameQueue((deltas) =>
      flushed.push(...deltas.map((delta) => delta.text.length))
    )

    queue.enqueue({ scopeId: 'c', messageId: 'm', blockIndex: 0 }, 'x'.repeat(240))
    expect(queue.drainBefore(completed)).toBe(true)
    for (let index = 0; index < 10; index += 1) {
      clock.tick()
    }

    expect(flushed).toEqual(Array.from({ length: 10 }, () => 24))
    expect(completed).toHaveBeenCalledOnce()
  })

  it('keeps normal cadence when completion follows the first buffered frame', () => {
    const clock = frameClock()
    const flushed: number[] = []
    const completed = vi.fn()
    const queue = new StreamingTextFrameQueue((deltas) =>
      flushed.push(...deltas.map((delta) => delta.text.length))
    )

    queue.enqueue({ scopeId: 'c', messageId: 'm', blockIndex: 0 }, 'x'.repeat(240))
    clock.tick()
    expect(queue.drainBefore(completed)).toBe(true)
    for (let index = 0; index < 9; index += 1) {
      clock.tick()
    }

    expect(flushed).toEqual(Array.from({ length: 10 }, () => 24))
    expect(completed).toHaveBeenCalledOnce()
  })

  it.each([60, 120])('reveals rate-limited text at 120 characters per second at %i Hz', (hz) => {
    const clock = frameClock()
    let flushed = 0
    const queue = new StreamingTextFrameQueue((deltas) => {
      flushed += deltas.reduce((total, delta) => total + delta.text.length, 0)
    })

    queue.enqueue({ scopeId: 'c', messageId: 'm', blockIndex: 0 }, 'x'.repeat(1_000), {
      charsPerSecond: BUFFERED_FINAL_CHARS_PER_SECOND
    })
    for (let frame = 0; frame < hz; frame += 1) {
      clock.tick(1_000 / hz)
    }

    expect(flushed).toBeGreaterThanOrEqual(119)
    expect(flushed).toBeLessThanOrEqual(121)
  })
})

function frameClock(): { tick: (elapsed?: number) => void } {
  let nextId = 1
  let timestamp = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextId
    nextId += 1
    callbacks.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => callbacks.delete(id))
  return {
    tick: (elapsed = 16) => {
      timestamp += elapsed
      const current = [...callbacks.entries()]
      callbacks.clear()
      for (const [, callback] of current) {
        callback(timestamp)
      }
    }
  }
}
