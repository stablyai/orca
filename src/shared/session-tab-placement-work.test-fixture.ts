import { vi } from 'vitest'
import * as placement from './session-tab-placement'

export function observeSessionTabPlacementWork() {
  const samples: { reads: number; adds: number; has: number }[] = []
  function measure<T>(work: () => T): T {
    const count = { reads: 0, adds: 0, has: 0 }
    const { includes, indexOf } = Array.prototype
    const { add, has } = Set.prototype
    const receiver = (array: unknown[]) =>
      new Proxy(array, {
        get(target, key) {
          if (key === 'length') {
            return target.length
          }
          if (typeof key !== 'string' || !/^\d+$/.test(key)) {
            return undefined
          }
          count.reads += 1
          return target[Number(key)]
        }
      })
    Array.prototype.includes = function (value, from) {
      return includes.call(receiver(this), value, from)
    }
    Array.prototype.indexOf = function (value, from) {
      return indexOf.call(receiver(this), value, from)
    }
    Set.prototype.add = function (value) {
      count.adds += 1
      return add.call(this, value)
    }
    Set.prototype.has = function (value) {
      count.has += 1
      return has.call(this, value)
    }
    try {
      return work()
    } finally {
      Object.assign(Array.prototype, { includes, indexOf })
      Object.assign(Set.prototype, { add, has })
      samples.push(count)
    }
  }
  const created = placement.placeCreatedSessionTab
  const unpinned = placement.placeUnpinnedSessionTabAtCapture
  vi.spyOn(placement, 'placeCreatedSessionTab').mockImplementation((...args) =>
    measure(() => created(...args))
  )
  vi.spyOn(placement, 'placeUnpinnedSessionTabAtCapture').mockImplementation((...args) =>
    measure(() => unpinned(...args))
  )
  return { samples }
}
