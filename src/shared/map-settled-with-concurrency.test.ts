import { describe, expect, it } from 'vitest'
import { mapSettledWithConcurrency } from './map-with-concurrency'

describe('mapSettledWithConcurrency', () => {
  it('preserves all-settled results and order while bounding a large fanout', async () => {
    const limit = 7
    const items = Array.from({ length: 1_000 }, (_, index) => index)
    let inFlight = 0
    let peak = 0

    const results = await mapSettledWithConcurrency(items, limit, async (item) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      for (let turn = 0; turn < item % 5; turn += 1) {
        await Promise.resolve()
      }
      inFlight -= 1
      if (item % 97 === 0) {
        throw `rejected-${item}`
      }
      return `fulfilled-${item}`
    })

    expect(peak).toBe(limit)
    expect(results).toEqual(
      items.map(
        (item): PromiseSettledResult<string> =>
          item % 97 === 0
            ? { status: 'rejected', reason: `rejected-${item}` }
            : { status: 'fulfilled', value: `fulfilled-${item}` }
      )
    )
  })
})
