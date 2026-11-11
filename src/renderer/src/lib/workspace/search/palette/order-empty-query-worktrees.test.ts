import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
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
  it('does not crash the switcher when a visible worktree has no displayName (crash 99657ab1)', () => {
    // Persisted/discovered displayName can be undefined despite its type; raw localeCompare once crashed Cmd+J.
    const named = wt({ id: 'a', displayName: 'apple', lastActivityAt: 100 })
    const unnamed = wt({
      id: 'b',
      displayName: undefined as unknown as string,
      lastActivityAt: 100
    })
    expect(() =>
      orderEmptyQueryWorktrees({
        visibleWorktrees: [named, unnamed],
        activeWorktreeId: null,
        lastVisitedAtByWorktreeId: {}
      })
    ).not.toThrow()
  })

  // Filter current workspace by host too or its same-ID SSH twin becomes unreachable.
  it('keeps the same-id worktree on the other host switchable', () => {
    const local = wt({ id: 'shared', displayName: 'local', hostId: 'local' })
    const ssh = wt({ id: 'shared', displayName: 'ssh', hostId: 'ssh:box' })
    const result = orderEmptyQueryWorktrees({
      visibleWorktrees: [local, ssh],
      activeWorktreeId: 'shared',
      activeWorkspaceExecutionHostId: 'local',
      lastVisitedAtByWorktreeId: {}
    })
    expect(result.switchableWorktreesForRows.map((w) => w.displayName)).toEqual(['ssh'])
  })
})
