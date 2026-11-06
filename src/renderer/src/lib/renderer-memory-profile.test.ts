import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectRendererMemoryProfileCounts,
  registerRendererMemoryProfileContributor
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
})
