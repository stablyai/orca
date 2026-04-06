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
  it('returns 42 for header rows', () => {
    const header: Row = {
      type: 'header',
      key: 'test',
      label: 'Test',
      count: 1,
      icon: () => null,
      tone: ''
    }
    expect(estimateRowHeight(header, [], repoMap, null)).toBe(42)
  })

  it('returns base height (56) for items with no metadata', () => {
    expect(estimateRowHeight(itemRow(worktree), [], repoMap, null)).toBe(56)
  })

  it('adds 22px for issue row when linkedIssue is set', () => {
    const wt = { ...worktree, linkedIssue: 42 }
    const base = estimateRowHeight(itemRow(worktree), ['issue'], repoMap, null)
    const withIssue = estimateRowHeight(itemRow(wt), ['issue'], repoMap, null)
    expect(withIssue - base).toBe(24) // 22px line + 2px mt-0.5
  })

  it('does not add issue height when cardProps excludes issue', () => {
    const wt = { ...worktree, linkedIssue: 42 }
    expect(estimateRowHeight(itemRow(wt), [], repoMap, null)).toBe(56)
  })

  it('adds 22px for PR row when prCache has data', () => {
    const prCache = {
      '/tmp/orca::feature/cool': { data: { number: 1 } }
    }
    const base = estimateRowHeight(itemRow(worktree), ['pr'], repoMap, null)
    const withPR = estimateRowHeight(itemRow(worktree), ['pr'], repoMap, prCache)
    expect(withPR - base).toBe(24) // 22px line + 2px mt-0.5
  })

  it('does not add PR height when prCache is null', () => {
    expect(estimateRowHeight(itemRow(worktree), ['pr'], repoMap, null)).toBe(56)
  })

  it('does not add PR height when prCache entry has no data', () => {
    const prCache = {
      '/tmp/orca::feature/cool': { data: null }
    }
    expect(estimateRowHeight(itemRow(worktree), ['pr'], repoMap, prCache)).toBe(56)
  })

  it('adds 22px for comment row', () => {
    const wt = { ...worktree, comment: 'todo: fix bug' }
    const base = estimateRowHeight(itemRow(worktree), ['comment'], repoMap, null)
    const withComment = estimateRowHeight(itemRow(wt), ['comment'], repoMap, null)
    expect(withComment - base).toBe(24) // 22px line + 2px mt-0.5
  })

  it('stacks all metadata lines correctly', () => {
    const wt = { ...worktree, linkedIssue: 42, comment: 'note' }
    const prCache = {
      '/tmp/orca::feature/cool': { data: { number: 1 } }
    }
    const h = estimateRowHeight(itemRow(wt), ['issue', 'pr', 'comment'], repoMap, prCache)
    // 52 base + 22 issue + 22 pr + 22 comment + 2 mt-0.5 + 4 pb-1 = 124
    expect(h).toBe(124)
  })

  it('strips refs/heads/ prefix when building PR cache key', () => {
    const wt = { ...worktree, branch: 'refs/heads/my-branch' }
    const prCache = {
      '/tmp/orca::my-branch': { data: { number: 5 } }
    }
    const h = estimateRowHeight(itemRow(wt), ['pr'], repoMap, prCache)
    expect(h).toBe(80) // 52 + 22 + 2 + 4
  })
})
