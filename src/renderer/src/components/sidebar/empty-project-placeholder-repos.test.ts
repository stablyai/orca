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
          visibleWorktrees: [],
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
          visibleWorktrees: [],
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
          visibleWorktrees: [],
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
        visibleWorktrees: [],
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
        visibleWorktrees: [],
        filterRepoIds: []
      }).size
    ).toBe(0)
  })

  it('keeps grouped repos visible when workspace filters hide all of their rows', () => {
    const groupedRepo: Repo = { ...repo, projectGroupId: 'group-1' }
    const groupedWorktree: Worktree = { ...worktree, repoId: groupedRepo.id }

    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [groupedRepo],
          worktreesByRepo: { [groupedRepo.id]: [groupedWorktree] },
          visibleWorktrees: [],
          filterRepoIds: []
        })
      )
    ).toEqual([groupedRepo.id])
  })

  it('does not create a grouped repo placeholder when one of its workspaces is visible', () => {
    const groupedRepo: Repo = { ...repo, projectGroupId: 'group-1' }
    const groupedWorktree: Worktree = { ...worktree, repoId: groupedRepo.id }

    expect(
      getEmptyProjectPlaceholderRepoIds({
        groupBy: 'repo',
        repos: [groupedRepo],
        worktreesByRepo: { [groupedRepo.id]: [groupedWorktree] },
        visibleWorktrees: [groupedWorktree],
        filterRepoIds: []
      }).size
    ).toBe(0)
  })

  it('still respects explicit project filters for sleep-filtered grouped members', () => {
    const selected: Repo = { ...repo, id: 'repo-selected', projectGroupId: 'group-1' }
    const filteredOut: Repo = { ...repo, id: 'repo-hidden', projectGroupId: 'group-1' }
    const selectedWt: Worktree = { ...worktree, id: 'wt-selected', repoId: selected.id }
    const hiddenWt: Worktree = { ...worktree, id: 'wt-hidden', repoId: filteredOut.id }

    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [selected, filteredOut],
          worktreesByRepo: {
            [selected.id]: [selectedWt],
            [filteredOut.id]: [hiddenWt]
          },
          // Why: simulate Hide sleeping removing every card while the project
          // filter still intentionally excludes `filteredOut`.
          visibleWorktrees: [],
          filterRepoIds: [selected.id]
        })
      )
    ).toEqual([selected.id])
  })

  it('placeholders only the fully-filtered members of a multi-project group', () => {
    const sleeping: Repo = { ...repo, id: 'repo-sleeping', projectGroupId: 'group-1' }
    const awake: Repo = { ...repo, id: 'repo-awake', projectGroupId: 'group-1' }
    const sleepingWt: Worktree = { ...worktree, id: 'wt-sleeping', repoId: sleeping.id }
    const awakeWt: Worktree = { ...worktree, id: 'wt-awake', repoId: awake.id }

    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [sleeping, awake],
          worktreesByRepo: {
            [sleeping.id]: [sleepingWt],
            [awake.id]: [awakeWt]
          },
          visibleWorktrees: [awakeWt],
          filterRepoIds: []
        })
      )
    ).toEqual([sleeping.id])
  })

  it('does not placeholder ungrouped neighbors of a filtered grouped member', () => {
    const grouped: Repo = { ...repo, id: 'repo-grouped', projectGroupId: 'group-1' }
    const ungrouped: Repo = { ...repo, id: 'repo-ungrouped' }
    const groupedWt: Worktree = { ...worktree, id: 'wt-grouped', repoId: grouped.id }
    const ungroupedWt: Worktree = { ...worktree, id: 'wt-ungrouped', repoId: ungrouped.id }

    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [grouped, ungrouped],
          worktreesByRepo: {
            [grouped.id]: [groupedWt],
            [ungrouped.id]: [ungroupedWt]
          },
          visibleWorktrees: [],
          filterRepoIds: []
        })
      )
    ).toEqual([grouped.id])
  })
})
