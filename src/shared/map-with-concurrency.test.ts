import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './map-with-concurrency'

describe('mapWithConcurrency', () => {
  it('preserves input order in the result array regardless of settle order', async () => {
    // Later items resolve sooner, so a naive push-on-resolve would reorder.
    const results = await mapWithConcurrency([30, 20, 10], 3, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return index
    })
    expect(results).toEqual([0, 1, 2])
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 50 }, (_, i) => i)
    await mapWithConcurrency(items, 8, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
    })
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
})
