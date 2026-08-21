import { describe, expect, it, vi } from 'vitest'
import {
  createQuickOpenListingBudget,
  QuickOpenSubprocessPathAccumulator,
  resolveQuickOpenResultLimit,
  retainQuickOpenPath,
  QUICK_OPEN_LISTING_MAX_PATH_BYTES,
  QUICK_OPEN_LISTING_MAX_RETAINED_PATH_BYTES,
  QUICK_OPEN_LISTING_MAX_RETAINED_PATHS,
  QUICK_OPEN_LISTING_MAX_RESULTS
} from './quick-open-listing-limits'

describe('Quick Open listing limits', () => {
  it('uses one hard result cap while preserving smaller requested limits', () => {
    expect(resolveQuickOpenResultLimit()).toBe(QUICK_OPEN_LISTING_MAX_RESULTS)
    expect(resolveQuickOpenResultLimit(17)).toBe(17)
    expect(resolveQuickOpenResultLimit(QUICK_OPEN_LISTING_MAX_RESULTS + 1)).toBe(
      QUICK_OPEN_LISTING_MAX_RESULTS
    )
    expect(resolveQuickOpenResultLimit(0)).toBe(0)
  })

  it('keeps the production memory ceilings explicit', () => {
    expect(QUICK_OPEN_LISTING_MAX_RESULTS).toBe(20_001)
    expect(QUICK_OPEN_LISTING_MAX_RETAINED_PATHS).toBe(100_000)
    expect(QUICK_OPEN_LISTING_MAX_RETAINED_PATH_BYTES).toBe(32 * 1024 * 1024)
    expect(QUICK_OPEN_LISTING_MAX_PATH_BYTES).toBe(64 * 1024)
  })

  it('accepts the exact retained path boundaries without charging duplicates', () => {
    const paths = new Set<string>()
    const budget = createQuickOpenListingBudget({
      maxRetainedPaths: 2,
      maxRetainedPathBytes: 3,
      maxPathBytes: 2
    })

    expect(retainQuickOpenPath(paths, 'ab', budget)).toBe(true)
    expect(retainQuickOpenPath(paths, 'ab', budget)).toBe(false)
    expect(retainQuickOpenPath(paths, 'c', budget)).toBe(true)
    expect(budget).toMatchObject({ retainedPathCount: 2, retainedPathBytes: 3 })
    expect(() => retainQuickOpenPath(paths, '', budget)).toThrow('2 retained paths')
  })

  it('rejects path-byte overflow without mutating the retained budget', () => {
    const paths = new Set<string>()
    const budget = createQuickOpenListingBudget({
      maxRetainedPaths: 3,
      maxRetainedPathBytes: 2,
      maxPathBytes: 2
    })
    retainQuickOpenPath(paths, 'ab', budget)

    expect(() => retainQuickOpenPath(paths, 'c', budget)).toThrow('2 retained path bytes')
    expect(paths).toEqual(new Set(['ab']))
    expect(budget).toMatchObject({ retainedPathCount: 1, retainedPathBytes: 2 })
  })

  it('bounds one fragmented subprocess path and recovers after overflow', () => {
    const onPath = vi.fn(() => true)
    const fields = new QuickOpenSubprocessPathAccumulator(0, 3)

    expect(fields.push(Buffer.from('ab'), onPath)).toBe('continue')
    expect(fields.push(Buffer.from('cd'), onPath)).toBe('path-too-large')
    expect(fields.push(Buffer.from('ok\0'), onPath)).toBe('continue')
    expect(onPath).toHaveBeenCalledTimes(1)
    expect(onPath).toHaveBeenCalledWith('ok')
  })

  it('stops within a multi-path chunk without visiting later fields', () => {
    const visited: string[] = []
    const fields = new QuickOpenSubprocessPathAccumulator(0, 16)

    expect(
      fields.push(Buffer.from('one\0two\0three\0'), (path) => {
        visited.push(path)
        return path !== 'two'
      })
    ).toBe('stopped')
    expect(visited).toEqual(['one', 'two'])
  })
})
