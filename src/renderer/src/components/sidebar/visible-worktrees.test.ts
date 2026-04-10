import { describe, expect, it } from 'vitest'
import { computeVisibleWorktreeIds } from './visible-worktrees'
import type { Repo, Worktree } from '../../../../shared/types'

function makeWorktree(id: string, repoId = 'repo1'): Worktree {
  return {
    id,
    repoId,
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    isArchived: false,
    isUnread: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

const repoMap = new Map<string, Repo>([
  [
    'repo1',
    {
      id: 'repo1',
      path: '/repo1',
      displayName: 'Repo 1',
      badgeColor: '#000',
      addedAt: 0
    }
  ]
])

describe('computeVisibleWorktreeIds', () => {
  it('treats browser-tab worktrees as active for the active-only filter', () => {
    const wt = makeWorktree('wt-browser')

    const result = computeVisibleWorktreeIds({ repo1: [wt] }, [wt.id], {
      filterRepoIds: [],
      searchQuery: '',
      showActiveOnly: true,
      tabsByWorktree: {},
      browserTabsByWorktree: { [wt.id]: [{ id: 'browser-1' }] },
      activeWorktreeId: null,
      repoMap,
      prCache: null,
      issueCache: null
    })

    expect(result).toEqual([wt.id])
  })

  it('keeps the currently active worktree visible even without PTYs', () => {
    const wt = makeWorktree('wt-active')

    const result = computeVisibleWorktreeIds({ repo1: [wt] }, [wt.id], {
      filterRepoIds: [],
      searchQuery: '',
      showActiveOnly: true,
      tabsByWorktree: {},
      browserTabsByWorktree: {},
      activeWorktreeId: wt.id,
      repoMap,
      prCache: null,
      issueCache: null
    })

    expect(result).toEqual([wt.id])
  })
})
