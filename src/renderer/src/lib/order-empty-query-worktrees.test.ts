import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/types'
import { orderEmptyQueryWorktrees } from './order-empty-query-worktrees'

function wt(overrides: Partial<Worktree> & { id: string; displayName: string }): Worktree {
  return {
    repoId: 'repo-1',
    path: `/tmp/${overrides.id}`,
    head: 'abc',
    branch: `refs/heads/${overrides.id}`,
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('orderEmptyQueryWorktrees', () => {
  it('ranks a recently visited (quiet) worktree above a noisy never-visited one', () => {
    // Why: the core bug — an SSH worktree the user just visited must outrank
    // a locally noisy worktree even when the latter has a newer lastActivityAt.
    const ssh = wt({ id: 'ssh', displayName: 'ssh', lastActivityAt: 1_000 })
    const local = wt({ id: 'local', displayName: 'local', lastActivityAt: 9_999 })
    const result = orderEmptyQueryWorktrees({
      visibleWorktrees: [local, ssh],
      activeWorktreeId: null,
      lastVisitedAtByWorktreeId: { ssh: 500 }
    })
    expect(result.switchableWorktreesForRows.map((w) => w.id)).toEqual(['ssh', 'local'])
  })

  it('sorts visited worktrees by lastVisitedAt descending', () => {
    const a = wt({ id: 'a', displayName: 'a' })
    const b = wt({ id: 'b', displayName: 'b' })
    const result = orderEmptyQueryWorktrees({
      visibleWorktrees: [a, b],
      activeWorktreeId: null,
      lastVisitedAtByWorktreeId: { a: 100, b: 200 }
    })
    expect(result.switchableWorktreesForRows.map((w) => w.id)).toEqual(['b', 'a'])
  })

  it('falls back to lastActivityAt for never-visited worktrees', () => {
    const a = wt({ id: 'a', displayName: 'a', lastActivityAt: 100 })
    const b = wt({ id: 'b', displayName: 'b', lastActivityAt: 200 })
    const result = orderEmptyQueryWorktrees({
      visibleWorktrees: [a, b],
      activeWorktreeId: null,
      lastVisitedAtByWorktreeId: {}
    })
    expect(result.switchableWorktreesForRows.map((w) => w.id)).toEqual(['b', 'a'])
  })

  it('uses displayName as final tie-breaker', () => {
    const a = wt({ id: 'a', displayName: 'apple', lastActivityAt: 100 })
    const b = wt({ id: 'b', displayName: 'banana', lastActivityAt: 100 })
    const result = orderEmptyQueryWorktrees({
      visibleWorktrees: [b, a],
      activeWorktreeId: null,
      lastVisitedAtByWorktreeId: {}
    })
    expect(result.switchableWorktreesForRows.map((w) => w.id)).toEqual(['a', 'b'])
  })

  it('excludes current worktree from rows but includes it in state list', () => {
    const cur = wt({ id: 'cur', displayName: 'cur' })
    const other = wt({ id: 'other', displayName: 'other' })
    const result = orderEmptyQueryWorktrees({
      visibleWorktrees: [cur, other],
      activeWorktreeId: 'cur',
      lastVisitedAtByWorktreeId: {}
    })
    expect(result.switchableWorktreesForRows.map((w) => w.id)).toEqual(['other'])
    expect(result.visibleWorktreesForState.map((w) => w.id)).toEqual(['cur', 'other'])
  })

  it('returns empty rows but non-empty state when only the current worktree is visible', () => {
    const cur = wt({ id: 'cur', displayName: 'cur' })
    const result = orderEmptyQueryWorktrees({
      visibleWorktrees: [cur],
      activeWorktreeId: 'cur',
      lastVisitedAtByWorktreeId: {}
    })
    expect(result.switchableWorktreesForRows).toEqual([])
    expect(result.visibleWorktreesForState).toHaveLength(1)
  })
})
