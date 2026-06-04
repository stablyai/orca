import { describe, expect, it } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'
import { getEmptyProjectPlaceholderRepoIds } from './empty-project-placeholder-repos'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Project',
  badgeColor: '#000000',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'wt-1',
  repoId: repo.id,
  path: '/repo/wt-1',
  displayName: 'main',
  branch: 'refs/heads/main',
  head: 'abc123',
  isBare: false,
  isMainWorktree: true,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

describe('getEmptyProjectPlaceholderRepoIds', () => {
  it('returns empty repo placeholders in repo grouping without project groups', () => {
    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [repo],
          worktreesByRepo: { [repo.id]: [] },
          filterRepoIds: []
        })
      )
    ).toEqual([repo.id])
  })

  it('treats missing worktreesByRepo keys as empty for the current render', () => {
    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [repo],
          worktreesByRepo: {},
          filterRepoIds: []
        })
      )
    ).toEqual([repo.id])
  })

  it('applies repo filters to empty placeholder candidates', () => {
    const selectedRepo = { ...repo, id: 'repo-selected' }
    const hiddenRepo = { ...repo, id: 'repo-hidden' }

    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [selectedRepo, hiddenRepo],
          worktreesByRepo: { [selectedRepo.id]: [], [hiddenRepo.id]: [] },
          filterRepoIds: [selectedRepo.id]
        })
      )
    ).toEqual([selectedRepo.id])
  })

  it('does not create placeholders outside repo grouping', () => {
    expect(
      getEmptyProjectPlaceholderRepoIds({
        groupBy: 'none',
        repos: [repo],
        worktreesByRepo: { [repo.id]: [] },
        filterRepoIds: []
      }).size
    ).toBe(0)
  })

  it('does not treat non-empty repos as empty when workspace filters hide their rows', () => {
    expect(
      getEmptyProjectPlaceholderRepoIds({
        groupBy: 'repo',
        repos: [repo],
        worktreesByRepo: { [repo.id]: [worktree] },
        filterRepoIds: []
      }).size
    ).toBe(0)
  })
})
