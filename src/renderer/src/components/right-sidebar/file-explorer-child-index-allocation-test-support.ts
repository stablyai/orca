import { onTestFinished, vi } from 'vitest'
import type { TreeNode } from './file-explorer-types'

type Phase = 'idle' | 'admission' | 'exact' | 'normalized'
type AllocationCounts = {
  weakGets: number
  holders: number
  exactSets: number
  normalizedMaps: number
  facetArrays: number
  facetCopies: number
  facetTupleEntries: number
  allSets: number
  allMaps: number
  allArrays: number
  allCopies: number
}

/** WeakMap uses original descriptors: mock bookkeeping itself uses WeakMaps. */
export function measureFileExplorerChildIndexAllocations(
  counts: AllocationCounts,
  phase: () => Phase,
  children: () => readonly TreeNode[] | undefined
) {
  const exactSets: Set<unknown>[] = [],
    normalizedMaps: Map<unknown, unknown>[] = []
  const getDescriptor = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get')!
  const setDescriptor = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'set')!
  const weakGet = WeakMap.prototype.get,
    weakSet = WeakMap.prototype.set
  Object.defineProperty(WeakMap.prototype, 'get', {
    ...getDescriptor,
    value: function (this: WeakMap<WeakKey, unknown>, key: WeakKey) {
      if (key === children()) {
        counts.weakGets++
      }
      return weakGet.call(this, key)
    }
  })
  Object.defineProperty(WeakMap.prototype, 'set', {
    ...setDescriptor,
    value: function (this: WeakMap<WeakKey, unknown>, key: WeakKey, value: unknown) {
      if (key === children()) {
        counts.holders++
      }
      return weakSet.call(this, key, value)
    }
  })
  onTestFinished(() => {
    Object.defineProperty(WeakMap.prototype, 'get', getDescriptor)
    Object.defineProperty(WeakMap.prototype, 'set', setDescriptor)
  })
  const NativeSet = Set,
    NativeMap = Map
  vi.stubGlobal(
    'Set',
    new Proxy(NativeSet, {
      construct(target, args, newTarget) {
        const value: unknown = Reflect.construct(target, args, newTarget)
        if (!(value instanceof NativeSet)) {
          throw new Error('Set construction failed')
        }
        counts.allSets++
        if (phase() === 'exact') {
          counts.exactSets++
          exactSets.push(value)
        }
        return value
      }
    })
  )
  vi.stubGlobal(
    'Map',
    new Proxy(NativeMap, {
      construct(target, args, newTarget) {
        const value: unknown = Reflect.construct(target, args, newTarget)
        if (!(value instanceof NativeMap)) {
          throw new Error('Map construction failed')
        }
        counts.allMaps++
        if (phase() === 'normalized') {
          counts.normalizedMaps++
          normalizedMaps.push(value)
          if (Array.isArray(args[0])) {
            for (const entry of args[0]) {
              if (Array.isArray(entry)) {
                counts.facetTupleEntries++
              }
            }
          }
        }
        return value
      }
    })
  )
  const from = Array.from,
    map = Array.prototype.map,
    slice = Array.prototype.slice
  vi.spyOn(Array, 'from').mockImplementation((...args: Parameters<typeof Array.from>) => {
    counts.allArrays++
    if (phase() !== 'idle') {
      counts.facetArrays++
    }
    return from(...args)
  })
  vi.spyOn(Array.prototype, 'map').mockImplementation(function (
    this: unknown[],
    callback,
    thisArg
  ) {
    counts.allArrays++
    if (phase() !== 'idle') {
      counts.facetArrays++
    }
    return map.call(this, callback, thisArg)
  })
  vi.spyOn(Array.prototype, 'slice').mockImplementation(function (this: unknown[], start, end) {
    counts.allCopies++
    if (phase() !== 'idle') {
      counts.facetCopies++
    }
    return slice.call(this, start, end)
  })
  return () => ({
    exactEntries: exactSets.reduce((sum, set) => sum + set.size, 0),
    normalizedEntries: normalizedMaps.reduce((sum, map) => sum + map.size, 0)
  })
}
