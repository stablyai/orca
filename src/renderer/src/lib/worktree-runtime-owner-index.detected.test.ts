import { describe, expect, it } from 'vitest'

import {
  findIndexedDetectedWorktrees,
  hasIndexedDetectedWorktree
} from './worktree-runtime-owner-index'

describe('detected worktree index', () => {
  it('re-indexes a new catalog identity instead of serving stale hits', () => {
    const worktree = { id: 'repo::wt', repoId: 'repo' }
    const before = { repo: { worktrees: [worktree] } }
    expect(hasIndexedDetectedWorktree(before, 'repo::wt')).toBe(true)

    const afterRemoval = { repo: { worktrees: [] } }
    expect(hasIndexedDetectedWorktree(afterRemoval, 'repo::wt')).toBe(false)

    const afterReadd = { repo: { worktrees: [worktree] } }
    expect(findIndexedDetectedWorktrees(afterReadd, 'repo::wt')).toEqual([worktree])
    // The prior identity keeps its own cached answer; nothing bleeds between snapshots.
    expect(hasIndexedDetectedWorktree(afterRemoval, 'repo::wt')).toBe(false)
    expect(hasIndexedDetectedWorktree(before, 'repo::wt')).toBe(true)
  })
})
