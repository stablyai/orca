import { expect, it } from 'vitest'
import { forEachWithConcurrency, mapWithConcurrency } from './map-with-concurrency'

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
