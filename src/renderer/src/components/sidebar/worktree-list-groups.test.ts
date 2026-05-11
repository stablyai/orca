import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildRows, getPRGroupKey } from './worktree-list-groups'
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
  linkedLinearIssue: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  isPinned: false,
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

describe('buildRows with pinned worktrees', () => {
  const pinned = { ...worktree, id: 'wt-pinned', isPinned: true, displayName: 'pinned-feature' }
  const unpinned1 = { ...worktree, id: 'wt-1', displayName: 'alpha' }
  const unpinned2 = { ...worktree, id: 'wt-2', displayName: 'beta' }

  it('emits a Pinned header followed by pinned items in groupBy none', () => {
    const rows = buildRows('none', [unpinned1, pinned, unpinned2], repoMap, null, new Set())
    expect(rows[0]).toMatchObject({ type: 'header', key: 'pinned', label: 'Pinned', count: 1 })
    expect(rows[1]).toMatchObject({ type: 'item', worktree: { id: 'wt-pinned' } })
  })

  it('emits an All header between pinned and unpinned in groupBy none', () => {
    const rows = buildRows('none', [unpinned1, pinned, unpinned2], repoMap, null, new Set())
    expect(rows[2]).toMatchObject({ type: 'header', key: 'all', label: 'All', count: 2 })
    expect(rows[3]).toMatchObject({ type: 'item', worktree: { id: 'wt-1' } })
    expect(rows[4]).toMatchObject({ type: 'item', worktree: { id: 'wt-2' } })
  })

  it('excludes pinned items from regular groups in pr-status mode', () => {
    const rows = buildRows('pr-status', [unpinned1, pinned], repoMap, null, new Set())
    const pinnedHeader = rows.find((r) => r.type === 'header' && r.key === 'pinned')
    expect(pinnedHeader).toBeDefined()
    const prGroup = rows.filter((r) => r.type === 'header' && r.key.startsWith('pr:'))
    for (const header of prGroup) {
      if (header.type === 'header') {
        expect(header.count).toBe(1)
      }
    }
  })

  it('does not emit pinned section when no worktrees are pinned', () => {
    const rows = buildRows('none', [unpinned1, unpinned2], repoMap, null, new Set())
    expect(rows.every((r) => r.type === 'item')).toBe(true)
  })

  it('collapses pinned group when in collapsedGroups', () => {
    const rows = buildRows('none', [pinned, unpinned1], repoMap, null, new Set(['pinned']))
    expect(rows[0]).toMatchObject({ type: 'header', key: 'pinned' })
    expect(rows[1]).toMatchObject({ type: 'header', key: 'all' })
    expect(rows[2]).toMatchObject({ type: 'item', worktree: { id: 'wt-1' } })
  })

  it('does not emit All header when all worktrees are pinned', () => {
    const allPinned = { ...unpinned1, isPinned: true }
    const rows = buildRows('none', [pinned, allPinned], repoMap, null, new Set())
    expect(rows.some((r) => r.type === 'header' && r.key === 'all')).toBe(false)
  })

  it('preserves repo display casing in group labels', () => {
    const lowercaseRepo = { ...repo, displayName: 'c15t' }
    const rows = buildRows('repo', [worktree], new Map([[repo.id, lowercaseRepo]]), null, new Set())

    expect(rows[0]).toMatchObject({ type: 'header', label: 'c15t' })
  })

  it('groups folder-mode workspaces under their folder name', () => {
    const folderRepo: Repo = {
      ...repo,
      id: 'folder-1',
      path: '/tmp/design-assets',
      displayName: 'design-assets',
      kind: 'folder'
    }
    const folderWorktree: Worktree = {
      ...worktree,
      id: 'folder-1::/tmp/design-assets',
      repoId: folderRepo.id,
      path: folderRepo.path,
      branch: '',
      displayName: folderRepo.displayName,
      isMainWorktree: true
    }
    const rows = buildRows(
      'repo',
      [folderWorktree],
      new Map([[folderRepo.id, folderRepo]]),
      null,
      new Set()
    )

    expect(rows[0]).toMatchObject({
      type: 'header',
      key: 'repo:folder-1',
      label: 'design-assets',
      count: 1,
      repo: folderRepo
    })
    expect(rows[1]).toMatchObject({ type: 'item', worktree: { id: folderWorktree.id } })
  })
})

describe('buildRows repo grouping order', () => {
  const repoA: Repo = { ...repo, id: 'repo-a', displayName: 'alpha' }
  const repoB: Repo = { ...repo, id: 'repo-b', displayName: 'beta' }
  const repoC: Repo = { ...repo, id: 'repo-c', displayName: 'gamma' }
  const map = new Map([
    [repoA.id, repoA],
    [repoB.id, repoB],
    [repoC.id, repoC]
  ])
  const wA: Worktree = { ...worktree, id: 'wt-a', repoId: repoA.id, displayName: 'a' }
  const wB: Worktree = { ...worktree, id: 'wt-b', repoId: repoB.id, displayName: 'b' }
  const wC: Worktree = { ...worktree, id: 'wt-c', repoId: repoC.id, displayName: 'c' }

  it('orders repo headers by explicit repoOrder, not first-encounter', () => {
    // Worktree stream encounters in order C, A, B — but repoOrder says B, A, C.
    const repoOrder = new Map([
      [repoB.id, 0],
      [repoA.id, 1],
      [repoC.id, 2]
    ])
    const rows = buildRows('repo', [wC, wA, wB], map, null, new Set(), repoOrder)
    const headerKeys = rows.filter((r) => r.type === 'header').map((r) => r.key)
    expect(headerKeys).toEqual(['repo:repo-b', 'repo:repo-a', 'repo:repo-c'])
  })

  it('places unknown repo ids last and sorts them by label', () => {
    // Only repoB is in repoOrder; repoA and repoC fall through to label sort.
    const repoOrder = new Map([[repoB.id, 0]])
    const rows = buildRows('repo', [wC, wA, wB], map, null, new Set(), repoOrder)
    const headerKeys = rows.filter((r) => r.type === 'header').map((r) => r.key)
    expect(headerKeys).toEqual(['repo:repo-b', 'repo:repo-a', 'repo:repo-c'])
  })
})

describe('WorktreeList header styles', () => {
  it('does not title-case workspace group labels', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./WorktreeList.tsx', import.meta.url)),
      'utf8'
    )

    expect(source).not.toContain('leading-none capitalize')
  })
})
