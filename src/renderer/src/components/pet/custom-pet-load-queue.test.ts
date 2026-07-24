import { describe, expect, it } from 'vitest'
import {
  CustomPetLoadQueue,
  MAX_CONCURRENT_CUSTOM_PET_LOADS,
  MAX_PENDING_CUSTOM_PET_LOADS
} from './custom-pet-load-queue'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('CustomPetLoadQueue', () => {
  it('bounds active and retained pending loads', async () => {
    const queue = new CustomPetLoadQueue()
    const loads = Array.from({ length: MAX_PENDING_CUSTOM_PET_LOADS }, deferred)
    const pending = loads.map((load) => queue.run(() => load.promise))

    expect(queue.inspect()).toEqual({
      active: MAX_CONCURRENT_CUSTOM_PET_LOADS,
      pending: MAX_PENDING_CUSTOM_PET_LOADS
    })
    await expect(queue.run(() => Promise.resolve())).rejects.toThrow('Too many pending')

    loads.forEach((load) => load.resolve())
    await Promise.all(pending)
    expect(queue.inspect()).toEqual({ active: 0, pending: 0 })
  })
})
