import { expect, it } from 'vitest'
import { findWorktreeForSelectionOwner } from './worktree-selection-owner'
import { makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
const id = 'repo1::/same/path'
it.each([100, 200])(
  'indexes duplicate-owner publications with a bounded row-copy budget at N=%i',
  (n) => {
    const rows = Array.from({ length: n }, (_, i) =>
      makeWorktree({
        id,
        repoId: 'repo1',
        path: '/same/path',
        hostId: 'local',
        instanceId: `i${i}`
      })
    )
    const iterator = Array.prototype[Symbol.iterator]
    let rowYields = 0
    Array.prototype[Symbol.iterator] = function* (this: unknown[]) {
      for (const v of { [Symbol.iterator]: () => iterator.call(this) }) {
        if (v && typeof v === 'object' && 'id' in v && v.id === id) {
          rowYields++
        }
        yield v
      }
      return undefined
    }
    try {
      expect(
        findWorktreeForSelectionOwner(
          { worktreesByRepo: { repo1: rows }, repos: [] },
          { worktreeId: id, publisherHostId: 'local', executionHostId: 'local', instanceId: 'i0' }
        )
      ).toBeNull()
    } finally {
      Array.prototype[Symbol.iterator] = iterator
    }
    expect(rowYields).toBeLessThanOrEqual(4 * n)
  }
)
