import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import { compareWorktreeDisplayName } from './worktree-display-name-order'

// Persisted/discovered rows can lack required displayName (crash 99657ab1).
function worktree(id: string, displayName: string | undefined, lastActivityAt = 0): Worktree {
  return {
    id,
    repoId: 'repo',
    path: `/tmp/${id}`,
    head: 'head',
    branch: displayName ?? id,
    isBare: false,
    isMainWorktree: false,
    displayName: displayName as string,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt
  } as Worktree
}

describe('compareWorktreeDisplayName', () => {
  it('does not throw when a displayName is undefined (crash 99657ab1)', () => {
    const a = worktree('a', undefined)
    const b = worktree('b', 'Beta')
    expect(() => compareWorktreeDisplayName(a, b)).not.toThrow()
    // undefined coalesces to '' which sorts before a real name.
    expect(compareWorktreeDisplayName(a, b)).toBeLessThan(0)
    expect(compareWorktreeDisplayName(b, a)).toBeGreaterThan(0)
  })
})
