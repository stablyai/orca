import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectRendererMemoryProfileCounts,
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

  // Why: a marker that is always present carries no information, so the negative
  // case has to be pinned alongside the positive ones.
  it('does not claim truncation when everything fit', () => {
    register('store', () => ({ worktrees: 40 }))

    expect(collectRendererMemoryProfileCounts()).not.toHaveProperty('profile.truncated')
  })

  // Why the two markers must stay decoupled: a real session sits on the store's own
  // limit routinely, so wiring it to profile.truncated pins that flag to 1 forever and
  // it stops meaning "a whole contributor is missing". The contributor reports its own
  // drop by name instead.
  it('reports a contributor drop by name without claiming profile truncation', () => {
    const state = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `slice${index}`,
        Array.from({ length: 5 }, () => 0)
      ])
    )
    register('store', () => summarizeStateCollectionSizes(state, 20))

    const counts = collectRendererMemoryProfileCounts()
    expect(counts['store.unreportedCollections']).toBe(10)
    expect(counts).not.toHaveProperty('profile.truncated')
  })

  it('omits the drop marker when a contributor hid nothing', () => {
    register('store', () => summarizeStateCollectionSizes({ worktrees: [1, 2] }, 20))

    expect(collectRendererMemoryProfileCounts()).toEqual({ 'store.worktrees': 2 })
  })

  it('caps a runaway contributor instead of bloating the breadcrumb', () => {
    register('runaway', () =>
      Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`key${index}`, index + 1]))
    )

    const counts = collectRendererMemoryProfileCounts()
    expect(Object.keys(counts)).toHaveLength(33)
    expect(counts['profile.truncated']).toBe(1)
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

    expect(Object.keys(collectRendererMemoryProfileCounts())).toHaveLength(33)
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

    const counts = collectRendererMemoryProfileCounts()
    // Why the marker matters most here: 'skipped' is omitted entirely, so without it
    // the report is indistinguishable from one where that subsystem measured zero.
    expect(Object.keys(counts)).toHaveLength(65)
    expect(counts['profile.truncated']).toBe(1)
    expect(skippedContributor).not.toHaveBeenCalled()
  })

  it('caps contributor calls when contributors return no counts', () => {
    const contributors = Array.from({ length: 100 }, () => vi.fn(() => ({})))
    contributors.forEach((contributor, index) => register(`empty-${index}`, contributor))

    // Why no truncation marker: the 36 surplus contributors are refused at
    // registration, so the registry holds exactly 64 and collection walks all of
    // them to a natural end. The marker covers collection-time loss, not this.
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
    expect(counts).toEqual({ 'oversized-key.valid': 2, 'profile.truncated': 1 })
  })

  it('skips an oversized contributor namespace without invoking it', () => {
    const contributor = vi.fn(() => ({ count: 1 }))
    register('x'.repeat(65), contributor)

    expect(collectRendererMemoryProfileCounts()).toEqual({})
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
      label: 'not-a-collection',
      count: 9
    }

    // Why unreportedCollections is part of the expectation: 4 collections were found
    // and 2 reported, and a report that hides the other 2 without saying so reads as
    // "these are all of them".
    expect(summarizeStateCollectionSizes(state, 2)).toEqual({
      worktrees: 50,
      tabs: 3,
      unreportedCollections: 2
    })
  })

  it('omits the marker when nothing was hidden', () => {
    expect(summarizeStateCollectionSizes({ worktrees: [1, 2] }, 20)).toEqual({ worktrees: 2 })
  })

  it('skips empty collections and non-objects', () => {
    expect(summarizeStateCollectionSizes({ empty: [], none: null }, 5)).toEqual({})
    expect(summarizeStateCollectionSizes(null, 5)).toEqual({})
  })
})
