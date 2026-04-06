import { describe, expect, it } from 'vitest'
import { getPRGroupKey, matchesSearch } from './worktree-list-groups'
import type { Repo, Worktree } from '../../../../shared/types'

const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/orca',
  displayName: 'orca',
  badgeColor: '#000000',
  addedAt: 0
}

const worktree: Worktree = {
  id: 'wt-1',
  repoId: repo.id,
  path: '/tmp/orca-feature',
  branch: 'refs/heads/feature/super-critical',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  displayName: 'feature/super-critical',
  sortOrder: 0,
  lastActivityAt: 0
}

const repoMap = new Map([[repo.id, repo]])

describe('getPRGroupKey', () => {
  it('puts merged PRs in the done group', () => {
    const prCache = {
      '/tmp/orca::feature/super-critical': {
        data: { state: 'merged' }
      }
    }

    expect(getPRGroupKey(worktree, repoMap, prCache)).toBe('done')
  })
})

describe('matchesSearch', () => {
  it('matches on displayName', () => {
    expect(matchesSearch(worktree, 'super-critical', repoMap, null, null)).toBe(true)
  })

  it('matches on branch name', () => {
    expect(matchesSearch(worktree, 'feature/super', repoMap, null, null)).toBe(true)
  })

  it('matches on repo displayName', () => {
    expect(matchesSearch(worktree, 'orca', repoMap, null, null)).toBe(true)
  })

  it('matches on comment', () => {
    const w = { ...worktree, comment: 'Fix the login bug' }
    expect(matchesSearch(w, 'login', repoMap, null, null)).toBe(true)
  })

  it('does not match empty comment', () => {
    expect(matchesSearch(worktree, 'login', repoMap, null, null)).toBe(false)
  })

  it('matches on PR number from cache', () => {
    const prCache = {
      '/tmp/orca::feature/super-critical': {
        data: { number: 304, title: 'Add search enhancements' }
      }
    }
    expect(matchesSearch(worktree, '304', repoMap, prCache, null)).toBe(true)
  })

  it('matches on PR title from cache', () => {
    const prCache = {
      '/tmp/orca::feature/super-critical': {
        data: { number: 304, title: 'Add search enhancements' }
      }
    }
    expect(matchesSearch(worktree, 'search enhance', repoMap, prCache, null)).toBe(true)
  })

  it('matches on linkedPR when cache is empty', () => {
    const w = { ...worktree, linkedPR: 42 }
    expect(matchesSearch(w, '42', repoMap, null, null)).toBe(true)
  })

  it('matches on issue number from linkedIssue', () => {
    const w = { ...worktree, linkedIssue: 99 }
    expect(matchesSearch(w, '99', repoMap, null, null)).toBe(true)
  })

  it('matches on issue title from cache', () => {
    const w = { ...worktree, linkedIssue: 99 }
    const issueCache = {
      '/tmp/orca::99': {
        data: { number: 99, title: 'Sidebar performance regression' }
      }
    }
    expect(matchesSearch(w, 'sidebar perf', repoMap, null, issueCache)).toBe(true)
  })

  it('strips # prefix for number matching', () => {
    const prCache = {
      '/tmp/orca::feature/super-critical': {
        data: { number: 304, title: 'Enhancement' }
      }
    }
    expect(matchesSearch(worktree, '#304', repoMap, prCache, null)).toBe(true)
  })

  it('strips # prefix for issue number matching', () => {
    const w = { ...worktree, linkedIssue: 55 }
    expect(matchesSearch(w, '#55', repoMap, null, null)).toBe(true)
  })

  it('returns false when nothing matches', () => {
    expect(matchesSearch(worktree, 'nonexistent-query-xyz', repoMap, null, null)).toBe(false)
  })

  it('handles null PR cache entry data gracefully', () => {
    const prCache = {
      '/tmp/orca::feature/super-critical': { data: null }
    }
    // Should fall through to other checks without error
    expect(matchesSearch(worktree, 'anything', repoMap, prCache, null)).toBe(false)
  })

  it('handles null issue cache entry data gracefully', () => {
    const w = { ...worktree, linkedIssue: 99 }
    const issueCache = {
      '/tmp/orca::99': { data: null }
    }
    // Should match on issue number but not crash on null title
    expect(matchesSearch(w, '99', repoMap, null, issueCache)).toBe(true)
  })

  it('does not treat bare # as a wildcard that matches all numbers', () => {
    const prCache = {
      '/tmp/orca::feature/super-critical': {
        data: { number: 304, title: 'Enhancement' }
      }
    }
    const w = { ...worktree, linkedIssue: 99 }
    expect(matchesSearch(w, '#', repoMap, prCache, null)).toBe(false)
  })
})
