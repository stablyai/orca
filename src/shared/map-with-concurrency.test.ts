import { describe, expect, it } from 'vitest'
import { forEachWithConcurrency, mapWithConcurrency } from './map-with-concurrency'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('mapWithConcurrency', () => {
  it('preserves exact-limit input order regardless of settle order', async () => {
    const gates = [deferred(), deferred(), deferred()]
    const settled: number[] = []
    const pending = mapWithConcurrency([0, 1, 2], 3, async (_, index) => {
      await gates[index]?.promise
      settled.push(index)
      return index
    })
    for (const index of [2, 1, 0]) {
      gates[index]?.resolve()
      await Promise.resolve()
    }
    expect(await pending).toEqual([0, 1, 2])
    expect(settled).toEqual([2, 1, 0])
  })

  it('starts every exact-limit callback synchronously like Promise.all', async () => {
    const started: number[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const result = mapWithConcurrency([0, 1, 2], 3, async (item) => {
      started.push(item)
      await gate
      return item
    })

    expect(started).toEqual([0, 1, 2])
    release()
    await expect(result).resolves.toEqual([0, 1, 2])
  })

  it('starts every exact-limit callback before surfacing a failure', async () => {
    const started: number[] = []
    const result = mapWithConcurrency([0, 1, 2], 3, async (item) => {
      started.push(item)
      if (item === 0) {
        throw new Error('boom')
      }
      return item
    })

    expect(started).toEqual([0, 1, 2])
    await expect(result).rejects.toThrow('boom')
  })

  it('never exceeds the concurrency limit', async () => {
    const gate = deferred()
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 50 }, (_, i) => i)
    const pending = mapWithConcurrency(items, 8, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await gate.promise
      inFlight -= 1
    })
    expect(peak).toBe(8)
    gate.resolve()
    await pending
    expect(peak).toBeLessThanOrEqual(8)
    // With 50 items and limit 8, the pool should actually saturate.
    expect(peak).toBe(8)
  })

  it('processes every item exactly once', async () => {
    const seen: number[] = []
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n)
    })
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('returns an empty array for no items without spawning workers', async () => {
    let calls = 0
    const results = await mapWithConcurrency([], 4, async () => {
      calls += 1
    })
    expect(results).toEqual([])
    expect(calls).toBe(0)
  })

  it('clamps a limit below one to a single worker instead of stalling', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 0, async (n) => n * 2)
    expect(results).toEqual([2, 4, 6])
  })

  it('clamps a NaN limit to one worker instead of skipping every item', async () => {
    const seen: number[] = []
    const results = await mapWithConcurrency([1, 2, 3], Number.NaN, async (item) => {
      seen.push(item)
      return item * 2
    })

    expect(seen).toEqual([1, 2, 3])
    expect(results).toEqual([2, 4, 6])
  })
})

describe('forEachWithConcurrency', () => {
  it('bounds concurrency without allocating a result per input', async () => {
    const gate = deferred()
    let inFlight = 0
    let peak = 0
    const seen: number[] = []

    const pending = forEachWithConcurrency(
      Array.from({ length: 50 }, (_, index) => index),
      8,
      async (item) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await gate.promise
        seen.push(item)
        inFlight -= 1
      }
    )

    expect(peak).toBe(8)
    gate.resolve()
    await pending
    expect(peak).toBe(8)
    expect(seen.sort((left, right) => left - right)).toEqual(
      Array.from({ length: 50 }, (_, index) => index)
    )
  })

  it('clamps a NaN limit to one worker instead of skipping every item', async () => {
    const seen: number[] = []

    await forEachWithConcurrency([1, 2, 3], Number.NaN, async (item) => {
      seen.push(item)
    })

    expect(seen).toEqual([1, 2, 3])
  })
})
