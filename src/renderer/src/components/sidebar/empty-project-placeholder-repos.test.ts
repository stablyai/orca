import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
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
          filterRepoIds: [],
          startupWorktreeRefreshCompleted: true
        })
      )
    ).toEqual([repo.id])
  })

  it('treats a missing worktreesByRepo key as empty once startup has settled', () => {
    // A failed scan never writes a key; the header must still come back. #16247
    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [repo],
          worktreesByRepo: {},
          visibleWorktrees: [],
          filterRepoIds: [],
          startupWorktreeRefreshCompleted: true
        })
      )
    ).toEqual([repo.id])
  })

  it('does not placeholder an unscanned repo while startup is still refreshing', () => {
    // Repos land before their scans; reading `undefined` as empty paints all of them. #16247
    expect(
      getEmptyProjectPlaceholderRepoIds({
        groupBy: 'repo',
        repos: [repo],
        worktreesByRepo: {},
        visibleWorktrees: [],
        filterRepoIds: [],
        startupWorktreeRefreshCompleted: false
      }).size
    ).toBe(0)
  })

  it('placeholders a scanned-empty repo during startup', () => {
    // `[]` is settled even mid-startup, so an empty project appears as soon as it scans.
    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [repo],
          worktreesByRepo: { [repo.id]: [] },
          visibleWorktrees: [],
          filterRepoIds: [],
          startupWorktreeRefreshCompleted: false
        })
      )
    ).toEqual([repo.id])
  })

  it('converges monotonically as scans land during startup', () => {
    const scanned: Repo = { ...repo, id: 'repo-scanned' }
    const unscanned: Repo = { ...repo, id: 'repo-unscanned' }
    const repos = [scanned, unscanned]

    const duringStartup = getEmptyProjectPlaceholderRepoIds({
      groupBy: 'repo',
      repos,
      worktreesByRepo: { [scanned.id]: [] },
      visibleWorktrees: [],
      filterRepoIds: [],
      startupWorktreeRefreshCompleted: false
    })
    const afterSecondScan = getEmptyProjectPlaceholderRepoIds({
      groupBy: 'repo',
      repos,
      worktreesByRepo: { [scanned.id]: [], [unscanned.id]: [] },
      visibleWorktrees: [],
      filterRepoIds: [],
      startupWorktreeRefreshCompleted: false
    })

    expect(Array.from(duringStartup)).toEqual([scanned.id])
    // The list only grows: no header is painted and then withdrawn.
    for (const id of duringStartup) {
      expect(afterSecondScan.has(id)).toBe(true)
    }
    expect(Array.from(afterSecondScan)).toEqual([scanned.id, unscanned.id])
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
          filterRepoIds: [selectedRepo.id],
          startupWorktreeRefreshCompleted: true
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
        filterRepoIds: [],
        startupWorktreeRefreshCompleted: true
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
        filterRepoIds: [],
        startupWorktreeRefreshCompleted: true
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
          filterRepoIds: [],
          startupWorktreeRefreshCompleted: true
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
        filterRepoIds: [],
        startupWorktreeRefreshCompleted: true
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
          filterRepoIds: [selected.id],
          startupWorktreeRefreshCompleted: true
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
          filterRepoIds: [],
          startupWorktreeRefreshCompleted: true
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
          filterRepoIds: [],
          startupWorktreeRefreshCompleted: true
        })
      )
    ).toEqual([grouped.id])
  })
})
