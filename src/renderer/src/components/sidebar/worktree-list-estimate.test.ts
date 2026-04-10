import { describe, expect, it } from 'vitest'
import { estimateRowHeight } from './worktree-list-estimate'
import type { Repo, Worktree } from '../../../../shared/types'
import type { Row } from './worktree-list-groups'

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
  branch: 'refs/heads/feature/cool',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  displayName: 'feature/cool',
  sortOrder: 0,
  lastActivityAt: 0
}

const repoMap = new Map([[repo.id, repo]])

function itemRow(wt: Worktree): Row {
  return { type: 'item', worktree: wt, repo }
}

describe('estimateRowHeight', () => {
  it('returns 38 for header rows', () => {
    const header: Row = {
      type: 'header',
      key: 'test',
      label: 'Test',
      count: 1,
      icon: () => null,
      tone: ''
    }
    expect(estimateRowHeight(header, [], repoMap, null)).toBe(38)
  })

  it('returns base height (55) for items with no metadata', () => {
    expect(estimateRowHeight(itemRow(worktree), [], repoMap, null)).toBe(55)
  })

  it('adds 24px for issue row when linkedIssue is set', () => {
    const wt = { ...worktree, linkedIssue: 42 }
    const base = estimateRowHeight(itemRow(worktree), ['issue'], repoMap, null)
    const withIssue = estimateRowHeight(itemRow(wt), ['issue'], repoMap, null)
    expect(withIssue - base).toBe(24) // 16px row + 8px meta-section spacing
  })

  it('does not add issue height when cardProps excludes issue', () => {
    const wt = { ...worktree, linkedIssue: 42 }
    expect(estimateRowHeight(itemRow(wt), [], repoMap, null)).toBe(55)
  })

  it('adds 24px for PR row when prCache has data', () => {
    const prCache = {
      '/tmp/orca::feature/cool': { data: { number: 1 } }
    }
    const base = estimateRowHeight(itemRow(worktree), ['pr'], repoMap, null)
    const withPR = estimateRowHeight(itemRow(worktree), ['pr'], repoMap, prCache)
    expect(withPR - base).toBe(24) // 16px row + 8px meta-section spacing
  })

  it('does not add PR height when prCache is null', () => {
    expect(estimateRowHeight(itemRow(worktree), ['pr'], repoMap, null)).toBe(55)
  })

  it('does not add PR height when prCache entry has no data', () => {
    const prCache = {
      '/tmp/orca::feature/cool': { data: null }
    }
    expect(estimateRowHeight(itemRow(worktree), ['pr'], repoMap, prCache)).toBe(55)
  })

  it('estimates comment height based on content length', () => {
    const wt = { ...worktree, comment: 'todo: fix bug' }
    const base = estimateRowHeight(itemRow(worktree), ['comment'], repoMap, null)
    const withComment = estimateRowHeight(itemRow(wt), ['comment'], repoMap, null)
    // 1 line × ceil(16.5)=17 + 4px py-0.5 + 8px meta spacing = 29
    expect(withComment - base).toBe(29)
  })

  it('estimates multi-line comment height from newlines', () => {
    const wt = { ...worktree, comment: 'first line\nsecond line\nthird line' }
    const h = estimateRowHeight(itemRow(wt), ['comment'], repoMap, null)
    // base 55 + ceil(3 × 16.5)=50 + 4px py-0.5 + 8px meta spacing = 117
    expect(h).toBe(117)
  })

  it('estimates wrapped long lines in comment', () => {
    // 70 chars wraps to 2 lines at ~35 chars/line
    const wt = { ...worktree, comment: 'a'.repeat(70) }
    const h = estimateRowHeight(itemRow(wt), ['comment'], repoMap, null)
    // base 55 + ceil(2 × 16.5)=33 + 4px py-0.5 + 8px meta spacing = 100
    expect(h).toBe(100)
  })

  it('stacks all metadata lines correctly', () => {
    const wt = { ...worktree, linkedIssue: 42, comment: 'note' }
    const prCache = {
      '/tmp/orca::feature/cool': { data: { number: 1 } }
    }
    const h = estimateRowHeight(itemRow(wt), ['issue', 'pr', 'comment'], repoMap, prCache)
    // 55 base + 16 issue + 16 pr + (17+4) comment + 8 meta spacing + 2×3 gaps = 122
    // (inter-card gap is handled by the virtualizer's `gap` option, not here)
    expect(h).toBe(122)
  })

  it('strips refs/heads/ prefix when building PR cache key', () => {
    const wt = { ...worktree, branch: 'refs/heads/my-branch' }
    const prCache = {
      '/tmp/orca::my-branch': { data: { number: 5 } }
    }
    const h = estimateRowHeight(itemRow(wt), ['pr'], repoMap, prCache)
    expect(h).toBe(79) // 55 + 16 + 8
  })

  it('adds 1px when both status and unread are in cardProps', () => {
    expect(estimateRowHeight(itemRow(worktree), ['status', 'unread'], repoMap, null)).toBe(56)
    expect(estimateRowHeight(itemRow(worktree), ['status'], repoMap, null)).toBe(55)
    expect(estimateRowHeight(itemRow(worktree), ['unread'], repoMap, null)).toBe(55)
  })
})
