import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PROFILE_CONTRIBUTOR_INVOCATIONS,
  collectRendererMemoryProfile,
  collectRendererMemoryProfileCounts,
  registerRendererMemoryProfileContributor,
  summarizeStateCollectionSizes,
  type RendererMemoryProfileContribution
} from './renderer-memory-profile'

const unregisters: (() => void)[] = []

type Contributor = () => Record<string, number> | RendererMemoryProfileContribution

function register(name: string, contributor: Contributor): void {
  unregisters.push(registerRendererMemoryProfileContributor(name, contributor))
}

afterEach(() => {
  while (unregisters.length > 0) {
    unregisters.pop()?.()
  }
  vi.restoreAllMocks()
})

describe('collectRendererMemoryProfile', () => {
  it('pins the near-OOM contributor invocation cap', () => {
    expect(MAX_PROFILE_CONTRIBUTOR_INVOCATIONS).toBe(8)
  })

  it('separates memory-pool hypotheses and sound bounds', () => {
    register('queue', () => ({
      counts: { chars: 1024 },
      heuristicOnHeapKB: 2,
      heuristicExternalKB: 3,
      soundOnHeapBoundKB: 1
    }))

    expect(collectRendererMemoryProfile()).toEqual({
      counts: { 'queue.chars': 1024 },
      onHeapHeuristicByCategoryKB: { 'queue.onHeapHeuristicKB': 2 },
      externalHeuristicByCategoryKB: { 'queue.externalHeuristicKB': 3 },
      onHeapHeuristicSumKB: 2,
      soundOnHeapBoundContributorCount: 1,
      soundOnHeapBoundSumKB: 1
    })
  })

  it('namespaces counts and contains a throwing contributor', () => {
    register('broken', () => {
      throw new Error('boom')
    })
    register('store', () => ({ worktrees: 3, junk: Number.NaN }))

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

  it('caps reading a runaway contributor', () => {
    let reads = 0
    const descriptors = Object.fromEntries(
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
    register('runaway', () => Object.defineProperties({}, descriptors) as Record<string, number>)

    expect(Object.keys(collectRendererMemoryProfileCounts())).toHaveLength(32)
    expect(reads).toBe(32)
  })

  it('stops invoking contributors once the output cap is full', () => {
    register('first', () =>
      Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`key${index}`, index]))
    )
    register('second', () =>
      Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`key${index}`, index]))
    )
    const skipped = vi.fn(() => ({ shouldNotRun: 1 }))
    register('skipped', skipped)

    expect(Object.keys(collectRendererMemoryProfileCounts())).toHaveLength(64)
    expect(skipped).not.toHaveBeenCalled()
  })

  it('rotates the bounded invocation window between collections', () => {
    const contributors = Array.from(
      { length: MAX_PROFILE_CONTRIBUTOR_INVOCATIONS + 2 },
      (_, index) => vi.fn(() => ({ value: index }))
    )
    contributors.forEach((contributor, index) => register(`entry-${index}`, contributor))

    const first = collectRendererMemoryProfileCounts()
    const second = collectRendererMemoryProfileCounts()

    expect(Object.keys(first)).toHaveLength(MAX_PROFILE_CONTRIBUTOR_INVOCATIONS)
    expect(first).not.toHaveProperty(`entry-${MAX_PROFILE_CONTRIBUTOR_INVOCATIONS}.value`)
    expect(second).toHaveProperty(`entry-${MAX_PROFILE_CONTRIBUTOR_INVOCATIONS}.value`)
    expect(second).toHaveProperty(`entry-${MAX_PROFILE_CONTRIBUTOR_INVOCATIONS + 1}.value`)
  })

  it('emits contributor metadata before round-robin detail', () => {
    register('first', () =>
      Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`detail${index}`, index]))
    )
    register('second', () => ({ __budgetHit: 1, detail: 2 }))

    expect(Object.keys(collectRendererMemoryProfileCounts())[0]).toBe('second.__budgetHit')
  })

  it('does not retain contributors beyond the registry budget', () => {
    const firstUnregister = registerRendererMemoryProfileContributor('empty-0', () => ({}))
    unregisters.push(firstUnregister)
    for (let index = 1; index < 64; index += 1) {
      register(`empty-${index}`, () => ({}))
    }
    const overflow = vi.fn(() => ({ retained: 1 }))
    register('overflow', overflow)
    firstUnregister()

    expect(collectRendererMemoryProfileCounts()).toEqual({})
    expect(overflow).not.toHaveBeenCalled()
  })

  it('skips oversized namespaces and keys', () => {
    const contributor = vi.fn(() => ({ count: 1 }))
    register('x'.repeat(65), contributor)
    register('valid', () => ({ ['x'.repeat(81)]: 1, retained: 2 }))

    expect(collectRendererMemoryProfileCounts()).toEqual({ 'valid.retained': 2 })
    expect(contributor).not.toHaveBeenCalled()
  })
})

describe('summarizeStateCollectionSizes', () => {
  it('reports the largest collections first, capped at the limit', () => {
    const state = {
      worktrees: Array.from({ length: 50 }, () => 0),
      agentStatuses: new Map([['a', 1]]),
      tabs: new Set([1, 2, 3]),
      metaById: { a: 1, b: 2 },
      label: 'not-a-collection'
    }

    expect(summarizeStateCollectionSizes(state, 2)).toEqual({ worktrees: 50, tabs: 3 })
  })

  it('bounds collection scanning and emits metadata first', () => {
    const state = {
      huge: Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [index, true])),
      later: { retained: true }
    }

    const result = summarizeStateCollectionSizes(state, 5)
    expect(Object.keys(result)[0]).toBe('__scanBudgetHit')
    expect(result.huge).toBe(4096)
    expect(result).not.toHaveProperty('later')
  })

  it('skips empty collections and non-objects', () => {
    expect(summarizeStateCollectionSizes({ empty: [], none: null }, 5)).toEqual({})
    expect(summarizeStateCollectionSizes(null, 5)).toEqual({})
  })
})
