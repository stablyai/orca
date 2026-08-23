import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectRendererMemoryProfileCounts,
  collectRendererMemoryTrendCounts,
  createRendererMemoryCensus,
  registerRendererMemoryProfileContributor,
  summarizeStateCollectionSizes
} from './renderer-memory-profile'

const unregisters: (() => void)[] = []

function register(name: string, contributor: () => Record<string, number>): void {
  unregisters.push(registerRendererMemoryProfileContributor(name, contributor))
}

afterEach(() => {
  while (unregisters.length > 0) {
    unregisters.pop()?.()
  }
  vi.restoreAllMocks()
})

describe('collectRendererMemoryProfileCounts', () => {
  it('namespaces contributor counts and keeps only finite numbers', () => {
    register('store', () => ({ worktrees: 40, junk: Number.NaN }))
    register('terminals', () => ({ panes: 7 }))

    expect(collectRendererMemoryProfileCounts()).toEqual({
      'store.worktrees': 40,
      'terminals.panes': 7
    })
  })

  it('contains a throwing contributor instead of failing collection', () => {
    register('broken', () => {
      throw new Error('boom')
    })
    register('store', () => ({ worktrees: 3 }))

    expect(collectRendererMemoryProfileCounts()).toEqual({
      'broken.error': 1,
      'store.worktrees': 3
    })
  })

  it('unregisters cleanly', () => {
    const unregister = registerRendererMemoryProfileContributor('store', () => ({ a: 1 }))
    unregister()
    expect(collectRendererMemoryProfileCounts()).toEqual({})
  })

  it('caps a runaway contributor instead of bloating the breadcrumb', () => {
    register('runaway', () =>
      Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`key${index}`, index + 1]))
    )

    expect(Object.keys(collectRendererMemoryProfileCounts())).toHaveLength(32)
  })

  it('stops reading a runaway contributor after the output budget', () => {
    let reads = 0
    const contribution = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `key${index}`,
        {
          enumerable: true,
          get: () => {
            reads += 1
            return index
          }
        }
      ])
    )
    const counts = Object.defineProperties({}, contribution) as Record<string, number>
    register('runaway', () => counts)

    expect(Object.keys(collectRendererMemoryProfileCounts())).toHaveLength(32)
    expect(reads).toBe(32)
  })

  it('caps aggregate counts and skips contributors after the profile budget', () => {
    register('first', () =>
      Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`key${index}`, index]))
    )
    register('second', () =>
      Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`key${index}`, index]))
    )
    const skippedContributor = vi.fn(() => ({ shouldNotRun: 1 }))
    register('skipped', skippedContributor)

    expect(Object.keys(collectRendererMemoryProfileCounts())).toHaveLength(64)
    expect(skippedContributor).not.toHaveBeenCalled()
  })

  it('caps contributor calls when contributors return no counts', () => {
    const contributors = Array.from({ length: 100 }, () => vi.fn(() => ({})))
    contributors.forEach((contributor, index) => register(`empty-${index}`, contributor))

    expect(collectRendererMemoryProfileCounts()).toEqual({})
    expect(contributors.filter((contributor) => contributor.mock.calls.length > 0)).toHaveLength(64)
  })

  it('does not retain contributors beyond the registry budget', () => {
    const firstUnregister = registerRendererMemoryProfileContributor('empty-0', () => ({}))
    unregisters.push(firstUnregister)
    for (let index = 1; index < 64; index += 1) {
      register(`empty-${index}`, () => ({}))
    }
    const overflowContributor = vi.fn(() => ({ retained: 1 }))
    register('overflow', overflowContributor)

    firstUnregister()

    expect(collectRendererMemoryProfileCounts()).toEqual({})
    expect(overflowContributor).not.toHaveBeenCalled()
  })

  it('bounds inherited property inspection and oversized output keys', () => {
    const inherited = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`inherited${index}`, index])
    )
    register('inherited', () => Object.create(inherited) as Record<string, number>)
    register('oversized-key', () => ({ ['x'.repeat(10_000)]: 1, valid: 2 }))
    const hasOwnSpy = vi.spyOn(Object, 'hasOwn')

    const counts = collectRendererMemoryProfileCounts()
    expect(hasOwnSpy).toHaveBeenCalledTimes(34)
    expect(counts).toEqual({ 'oversized-key.valid': 2 })
  })

  it('skips an oversized contributor namespace without invoking it', () => {
    const contributor = vi.fn(() => ({ count: 1 }))
    register('x'.repeat(65), contributor)

    expect(collectRendererMemoryProfileCounts()).toEqual({})
    expect(contributor).not.toHaveBeenCalled()
  })
})

describe('collectRendererMemoryTrendCounts', () => {
  it('keeps only the heaviest keys of trend-tagged contributors', () => {
    unregisters.push(
      registerRendererMemoryProfileContributor(
        'storeKB',
        () => ({ tabs: 900, __totalKB: 4200, worktrees: 120, prs: 60, agents: 5, drafts: 2 }),
        { trendLimit: 5 }
      )
    )
    register('store', () => ({ worktrees: 40 }))

    expect(collectRendererMemoryTrendCounts()).toEqual({
      'storeKB.__totalKB': 4200,
      'storeKB.tabs': 900,
      'storeKB.worktrees': 120,
      'storeKB.prs': 60,
      'storeKB.agents': 5
    })
  })

  it('bounds the aggregate trend budget and contains throwing contributors', () => {
    unregisters.push(
      registerRendererMemoryProfileContributor(
        'broken',
        () => {
          throw new Error('boom')
        },
        { trendLimit: 4 }
      )
    )
    unregisters.push(
      registerRendererMemoryProfileContributor(
        'runaway',
        () => Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`key${index}`, index])),
        { trendLimit: 500 }
      )
    )

    const counts = collectRendererMemoryTrendCounts()
    expect(counts['broken.error']).toBe(1)
    expect(Object.keys(counts)).toHaveLength(8)
  })
})

// A sample that crosses a threshold runs both censuses, and storeKB walks every
// top-level store slice with a transient allocation the size of what it measures
// — the last thing to do twice with no heap headroom left.
describe('a census shared across one sample pass', () => {
  it('reads each contributor once for both the trend and the profile', () => {
    let reads = 0
    unregisters.push(
      registerRendererMemoryProfileContributor(
        'storeKB',
        () => {
          reads += 1
          return { __totalKB: 4200, tabs: 900 }
        },
        { trendLimit: 5 }
      )
    )
    const census = createRendererMemoryCensus()

    const trend = collectRendererMemoryTrendCounts(census)
    const profile = collectRendererMemoryProfileCounts(census)

    expect(reads).toBe(1)
    expect(trend).toEqual({ 'storeKB.__totalKB': 4200, 'storeKB.tabs': 900 })
    expect(profile).toEqual({ 'storeKB.__totalKB': 4200, 'storeKB.tabs': 900 })
  })

  it('keeps a fresh census per sample so the trend still moves', () => {
    let size = 10
    unregisters.push(
      registerRendererMemoryProfileContributor('storeKB', () => ({ __totalKB: (size += 10) }), {
        trendLimit: 1
      })
    )

    expect(collectRendererMemoryTrendCounts(createRendererMemoryCensus())).toEqual({
      'storeKB.__totalKB': 20
    })
    expect(collectRendererMemoryTrendCounts(createRendererMemoryCensus())).toEqual({
      'storeKB.__totalKB': 30
    })
  })

  it('reports a throwing contributor in both censuses without re-running it', () => {
    let reads = 0
    unregisters.push(
      registerRendererMemoryProfileContributor(
        'broken',
        () => {
          reads += 1
          throw new Error('boom')
        },
        { trendLimit: 4 }
      )
    )
    const census = createRendererMemoryCensus()

    expect(collectRendererMemoryTrendCounts(census)).toEqual({ 'broken.error': 1 })
    expect(collectRendererMemoryProfileCounts(census)).toEqual({ 'broken.error': 1 })
    expect(reads).toBe(1)
  })
})

// The shipped contributors are measured against MAX_PROFILE_COUNTS in
// renderer-memory-shipped-contributors.test.ts, which registers them for real.

describe('summarizeStateCollectionSizes', () => {
  it('reports the largest collections first, capped at the limit', () => {
    const state = {
      worktrees: Array.from({ length: 50 }, () => 0),
      agentStatuses: new Map([['a', 1]]),
      tabs: new Set([1, 2, 3]),
      metaById: { a: 1, b: 2 },
      label: 'not-a-collection',
      count: 9
    }

    expect(summarizeStateCollectionSizes(state, 2)).toEqual({
      worktrees: 50,
      tabs: 3
    })
  })

  it('skips empty collections and non-objects', () => {
    expect(summarizeStateCollectionSizes({ empty: [], none: null }, 5)).toEqual({})
    expect(summarizeStateCollectionSizes(null, 5)).toEqual({})
  })
})
