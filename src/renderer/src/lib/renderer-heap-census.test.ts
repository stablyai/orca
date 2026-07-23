// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import {
  HEAP_CENSUS_MAX_COLLECTIONS,
  HEAP_CENSUS_MIN_COLLECTION_SIZE,
  censusFromStoreState,
  collectRendererHeapCensus
} from './renderer-heap-census'

const storeState: Record<string, unknown> = {}
vi.mock('@/store', () => ({
  useAppStore: { getState: () => storeState }
}))

function record(size: number): Record<string, true> {
  const out: Record<string, true> = {}
  for (let i = 0; i < size; i++) {
    out[`k${i}`] = true
  }
  return out
}

describe('censusFromStoreState', () => {
  it('always reports domNodes and the total across every collection', () => {
    const census = censusFromStoreState(
      {
        smallMap: record(3),
        someArray: [1, 2, 3, 4],
        aSet: new Set([1, 2])
      },
      1234
    )
    expect(census.domNodes).toBe(1234)
    // total sums ALL collections regardless of the reporting threshold: 3+4+2
    expect(census.storeCollectionsTotalEntries).toBe(9)
  })

  it('counts Maps, Sets, arrays, and plain records; ignores functions/primitives/class instances', () => {
    class NotData {
      value = 1
    }
    const census = censusFromStoreState(
      {
        bigRecord: record(HEAP_CENSUS_MIN_COLLECTION_SIZE),
        bigMap: new Map(Array.from({ length: 150 }, (_, i) => [i, i])),
        action: () => undefined,
        scalar: 42,
        text: 'hello',
        classInstance: new NotData(),
        nothing: null
      },
      0
    )
    expect(census['store.bigRecord']).toBe(HEAP_CENSUS_MIN_COLLECTION_SIZE)
    expect(census['store.bigMap']).toBe(150)
    // class instance / function / scalar / null contribute nothing
    expect(census['store.action']).toBeUndefined()
    expect(census['store.classInstance']).toBeUndefined()
    expect(census.storeCollectionsTotalEntries).toBe(HEAP_CENSUS_MIN_COLLECTION_SIZE + 150)
  })

  it('only surfaces collections at or above the minimum size', () => {
    const census = censusFromStoreState(
      {
        justUnder: record(HEAP_CENSUS_MIN_COLLECTION_SIZE - 1),
        atThreshold: record(HEAP_CENSUS_MIN_COLLECTION_SIZE)
      },
      0
    )
    expect(census['store.justUnder']).toBeUndefined()
    expect(census['store.atThreshold']).toBe(HEAP_CENSUS_MIN_COLLECTION_SIZE)
    // but the small one still counts toward the total
    expect(census.storeCollectionsTotalEntries).toBe(
      HEAP_CENSUS_MIN_COLLECTION_SIZE - 1 + HEAP_CENSUS_MIN_COLLECTION_SIZE
    )
  })

  it('caps the reported collections and keeps the largest (the leak stands out)', () => {
    const state: Record<string, unknown> = {}
    for (let i = 0; i < HEAP_CENSUS_MAX_COLLECTIONS + 5; i++) {
      state[`c${i}`] = record(HEAP_CENSUS_MIN_COLLECTION_SIZE + i)
    }
    const census = censusFromStoreState(state, 0)
    const reported = Object.keys(census).filter((k) => k.startsWith('store.'))
    expect(reported.length).toBe(HEAP_CENSUS_MAX_COLLECTIONS)
    // The single largest collection must be present; the smallest must be dropped.
    const largest = HEAP_CENSUS_MIN_COLLECTION_SIZE + (HEAP_CENSUS_MAX_COLLECTIONS + 4)
    expect(census[`store.c${HEAP_CENSUS_MAX_COLLECTIONS + 4}`]).toBe(largest)
    expect(census['store.c0']).toBeUndefined()
  })
})

describe('collectRendererHeapCensus', () => {
  it('reads the live store + attached DOM node count', () => {
    for (const key of Object.keys(storeState)) {
      delete storeState[key]
    }
    storeState.bigByPaneKey = record(HEAP_CENSUS_MIN_COLLECTION_SIZE + 7)
    storeState.setSomething = (): void => undefined

    const parent = document.createElement('div')
    const child = document.createElement('span')
    parent.appendChild(child)
    document.body.appendChild(parent)

    const census = collectRendererHeapCensus()

    expect(census['store.bigByPaneKey']).toBe(HEAP_CENSUS_MIN_COLLECTION_SIZE + 7)
    expect(census['store.setSomething']).toBeUndefined()
    // domNodes is the live attached count; our two nodes are included.
    expect(typeof census.domNodes).toBe('number')
    expect(census.domNodes as number).toBeGreaterThanOrEqual(2)

    document.body.removeChild(parent)
  })
})
