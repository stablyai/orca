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
  let releaseSecond: () => void = () => {}
  let secondSettled = false
  const rejection = mapWithConcurrencyUntilFailure([0, 1, 2, 3], 2, async (item) => {
    started.push(item)
    if (item === 0) {
      throw new Error('first item failed')
    }
    await new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    secondSettled = true
  })
  let rejected = false
  rejection.catch(() => {
    rejected = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(rejected).toBe(false)
  releaseSecond()
  await expect(rejection).rejects.toThrow('first item failed')
  expect(secondSettled).toBe(true)
  expect(started).toEqual([0, 1])
})
