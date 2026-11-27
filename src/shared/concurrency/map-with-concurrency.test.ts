import { expect, it } from 'vitest'
import {
  forEachWithConcurrency,
  mapWithConcurrency,
  mapWithConcurrencyUntilFailure
} from './map-with-concurrency'

it('returns rejected promises for synchronous worker failures in small batches', async () => {
  const fail = (): Promise<never> => {
    throw new Error('Worker failed before returning a promise')
  }
  await expect(mapWithConcurrency([1], 2, fail)).rejects.toThrow(
    'Worker failed before returning a promise'
  )
  await expect(forEachWithConcurrency([1], 2, fail)).rejects.toThrow(
    'Worker failed before returning a promise'
  )
})

it('stops admitting items after a failure and settles in-flight ones before rejecting', async () => {
  const started: number[] = []
  let inFlight = 0
  const rejection = mapWithConcurrencyUntilFailure([0, 1, 2, 3, 4, 5, 6, 7], 2, async (item) => {
    started.push(item)
    inFlight += 1
    await new Promise((resolve) => setTimeout(resolve, item === 0 ? 0 : 5))
    inFlight -= 1
    if (item === 0) {
      throw new Error('first item failed')
    }
  })
  await expect(rejection).rejects.toThrow('first item failed')
  expect(inFlight).toBe(0)
  expect(started).toEqual([0, 1])
})
