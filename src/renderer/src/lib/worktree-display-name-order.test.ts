import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/types'
import { compareWorktreeDisplayName } from './worktree-display-name-order'

// displayName is typed `string`, but crash 99657ab1 proved it arrives undefined
// at runtime for persisted/discovered worktrees. Force that shape here.
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

  it('treats two undefined names as equal without throwing', () => {
    expect(compareWorktreeDisplayName(worktree('a', undefined), worktree('b', undefined))).toBe(0)
  })

  it('orders defined names lexicographically', () => {
    expect(
      compareWorktreeDisplayName(worktree('a', 'Apple'), worktree('b', 'Banana'))
    ).toBeLessThan(0)
  })

  it('keeps Array.sort safe when the list contains an undefined-name worktree', () => {
    const worktrees = [worktree('a', 'Charlie'), worktree('b', undefined), worktree('c', 'Alpha')]
    expect(() =>
      [...worktrees].sort((x, y) => {
        if (x.lastActivityAt !== y.lastActivityAt) {
          return y.lastActivityAt - x.lastActivityAt
        }
        return compareWorktreeDisplayName(x, y)
      })
    ).not.toThrow()
  })
})
