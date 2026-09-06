import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  filterSourceControlWorktrees,
  getSourceControlWorktreeSearchText
} from './worktree-picker-filter'

function makeWorktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: 'repo::/path',
    repoId: 'repo',
    displayName: 'feature/alpha',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    path: '/path',
    head: '0123456789abcdef',
    branch: 'feature/alpha',
    isBare: false,
    isMainWorktree: false,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const WORKTREES: readonly Worktree[] = [
  makeWorktree({
    id: 'repo::/main',
    displayName: 'orca',
    path: '/main',
    branch: 'main',
    isMainWorktree: true
  }),
  makeWorktree({
    id: 'repo::/worktrees/alpha',
    displayName: 'alpha',
    path: '/worktrees/alpha',
    branch: 'feature/alpha',
    comment: 'API refactor'
  }),
  makeWorktree({
    id: 'repo::/worktrees/beta',
    displayName: 'beta',
    path: '/worktrees/beta',
    branch: 'hotfix/login',
    comment: ''
  })
]

describe('getSourceControlWorktreeSearchText', () => {
  it('includes name, path, comment and branch', () => {
    const text = getSourceControlWorktreeSearchText(WORKTREES[1])
    expect(text).toContain('alpha')
    expect(text).toContain('/worktrees/alpha')
    expect(text).toContain('api refactor')
    expect(text).toContain('feature/alpha')
  })
})

describe('filterSourceControlWorktrees', () => {
  it('returns the full list for an empty query', () => {
    expect(filterSourceControlWorktrees(WORKTREES, '')).toBe(WORKTREES)
    expect(filterSourceControlWorktrees(WORKTREES, '   ')).toBe(WORKTREES)
  })

  it('matches the branch name', () => {
    expect(filterSourceControlWorktrees(WORKTREES, 'hotfix').map((w) => w.displayName)).toEqual([
      'beta'
    ])
  })

  it('matches the display name case-insensitively', () => {
    expect(filterSourceControlWorktrees(WORKTREES, 'ALPHA').map((w) => w.displayName)).toEqual([
      'alpha'
    ])
  })

  it('matches the comment', () => {
    expect(filterSourceControlWorktrees(WORKTREES, 'refactor').map((w) => w.displayName)).toEqual([
      'alpha'
    ])
  })

  it('returns no rows when nothing matches', () => {
    expect(filterSourceControlWorktrees(WORKTREES, 'zzz')).toEqual([])
  })
})
