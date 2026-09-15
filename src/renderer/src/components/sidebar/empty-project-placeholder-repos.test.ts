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
          hideDefaultBranchWorkspace: false
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
          filterRepoIds: [],
          hideDefaultBranchWorkspace: false
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
          filterRepoIds: [selectedRepo.id],
          hideDefaultBranchWorkspace: false
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
        hideDefaultBranchWorkspace: false
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
        hideDefaultBranchWorkspace: false
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
          hideDefaultBranchWorkspace: false
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
        hideDefaultBranchWorkspace: false
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
          hideDefaultBranchWorkspace: false
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
          hideDefaultBranchWorkspace: false
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
          hideDefaultBranchWorkspace: false
        })
      )
    ).toEqual([grouped.id])
  })

  it('does not create placeholders outside repo grouping even under Hide default branch', () => {
    expect(
      getEmptyProjectPlaceholderRepoIds({
        groupBy: 'none',
        repos: [repo],
        worktreesByRepo: { [repo.id]: [worktree] },
        visibleWorktrees: [],
        filterRepoIds: [],
        hideDefaultBranchWorkspace: true
      }).size
    ).toBe(0)
  })

  it('does not placeholder a provisioned-root checkout, which the filter leaves visible', () => {
    expect(
      getEmptyProjectPlaceholderRepoIds({
        groupBy: 'repo',
        repos: [repo],
        worktreesByRepo: {
          [repo.id]: [{ ...worktree, ephemeralVmCheckoutMode: 'provisioned-root' }]
        },
        visibleWorktrees: [],
        filterRepoIds: [],
        hideDefaultBranchWorkspace: true
      }).size
    ).toBe(0)
  })

  it('keeps an ungrouped repo visible when Hide default branch hides its only checkout', () => {
    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [repo],
          worktreesByRepo: { [repo.id]: [worktree] },
          visibleWorktrees: [],
          filterRepoIds: [],
          hideDefaultBranchWorkspace: true
        })
      )
    ).toEqual([repo.id])
  })

  it('ignores archived rows when deciding a repo is default-checkout-only', () => {
    const archivedFeature: Worktree = {
      ...worktree,
      id: 'wt-archived',
      branch: 'refs/heads/feature',
      isMainWorktree: false,
      isArchived: true
    }

    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [repo],
          worktreesByRepo: { [repo.id]: [worktree, archivedFeature] },
          visibleWorktrees: [],
          filterRepoIds: [],
          hideDefaultBranchWorkspace: true
        })
      )
    ).toEqual([repo.id])
  })

  it('does not placeholder a repo whose non-default rows are hidden by other filters', () => {
    const feature: Worktree = {
      ...worktree,
      id: 'wt-feature',
      branch: 'refs/heads/feature',
      isMainWorktree: false
    }

    // Why: one non-default row disqualifies the repo — the placeholder is for
    // default-checkout-only projects, not for any repo whose rows a filter hid.
    expect(
      getEmptyProjectPlaceholderRepoIds({
        groupBy: 'repo',
        repos: [repo],
        worktreesByRepo: { [repo.id]: [worktree, feature] },
        visibleWorktrees: [],
        filterRepoIds: [],
        hideDefaultBranchWorkspace: true
      }).size
    ).toBe(0)
  })

  it('does not placeholder a default-checkout-only repo while one of its rows is visible', () => {
    expect(
      getEmptyProjectPlaceholderRepoIds({
        groupBy: 'repo',
        repos: [repo],
        worktreesByRepo: { [repo.id]: [worktree] },
        visibleWorktrees: [worktree],
        filterRepoIds: [],
        hideDefaultBranchWorkspace: true
      }).size
    ).toBe(0)
  })

  it('applies repo filters to default-checkout-only placeholder candidates', () => {
    const selectedRepo = { ...repo, id: 'repo-selected' }
    const hiddenRepo = { ...repo, id: 'repo-hidden' }

    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [selectedRepo, hiddenRepo],
          worktreesByRepo: {
            [selectedRepo.id]: [{ ...worktree, id: 'wt-selected', repoId: selectedRepo.id }],
            [hiddenRepo.id]: [{ ...worktree, id: 'wt-hidden', repoId: hiddenRepo.id }]
          },
          visibleWorktrees: [],
          filterRepoIds: [selectedRepo.id],
          hideDefaultBranchWorkspace: true
        })
      )
    ).toEqual([selectedRepo.id])
  })
})
