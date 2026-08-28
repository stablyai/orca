import { describe, expect, it } from 'vitest'
import { computeVisibleWorktreeIds, sidebarHasActiveFilters } from './visible-worktrees'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree, WorkspaceStatusDefinition } from '../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-statuses'

const STATUSES: readonly WorkspaceStatusDefinition[] = DEFAULT_WORKSPACE_STATUSES

function makeWorktree(id: string, workspaceStatus?: string): Worktree {
  return {
    id,
    repoId: 'repo1',
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...(workspaceStatus ? { workspaceStatus } : {})
  }
}

const repoMap = new Map<string, Repo>([
  ['repo1', { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }]
])

type VisibleOptions = Parameters<typeof computeVisibleWorktreeIds>[2]

function visibleOptions(overrides: Partial<VisibleOptions> = {}): VisibleOptions {
  return {
    filterRepoIds: [],
    showSleepingWorkspaces: true,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    browserTabsByWorktree: {},
    worktreeIdsWithLiveAgent: new Set(),
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    pairedDeviceIdsByEnvironment: new Map(),
    repoMap,
    workspaceHostScope: 'all',
    defaultHostId: LOCAL_EXECUTION_HOST_ID,
    worktreeLineageById: {},
    ...overrides
  }
}

// One workspace per default status, plus one that has never been assigned a
// status (so it resolves to the catalog default, 'in-progress').
const todo = makeWorktree('wt-todo', 'todo')
const inProgress = makeWorktree('wt-in-progress', 'in-progress')
const inReview = makeWorktree('wt-in-review', 'in-review')
const done = makeWorktree('wt-done', 'completed')
const unset = makeWorktree('wt-unset')

const worktreesByRepo = { repo1: [todo, inProgress, inReview, done, unset] }
const sortedIds = ['wt-todo', 'wt-in-progress', 'wt-in-review', 'wt-done', 'wt-unset']

function visibleWith(overrides: Partial<VisibleOptions>): string[] {
  return computeVisibleWorktreeIds(worktreesByRepo, sortedIds, visibleOptions(overrides))
}

describe('computeVisibleWorktreeIds workspace-status filter', () => {
  it('shows every status when the selection is empty', () => {
    expect(visibleWith({ filterWorkspaceStatuses: [], workspaceStatuses: STATUSES })).toEqual(
      sortedIds
    )
  })

  it('narrows the list to a single selected status', () => {
    expect(
      visibleWith({ filterWorkspaceStatuses: ['completed'], workspaceStatuses: STATUSES })
    ).toEqual(['wt-done'])
  })

  it('unions multiple selected statuses in sort order', () => {
    expect(
      visibleWith({
        filterWorkspaceStatuses: ['todo', 'in-review'],
        workspaceStatuses: STATUSES
      })
    ).toEqual(['wt-todo', 'wt-in-review'])
  })

  it('resolves an unset workspaceStatus to the catalog default', () => {
    // 'in-progress' is the catalog default, so the never-assigned workspace
    // must ride along with the explicitly in-progress one.
    expect(
      visibleWith({ filterWorkspaceStatuses: ['in-progress'], workspaceStatuses: STATUSES })
    ).toEqual(['wt-in-progress', 'wt-unset'])
  })

  it('returns an empty list when no workspace holds a selected status', () => {
    // The empty-result state the sidebar's "No workspaces found" + Clear
    // Filters escape hatch renders against.
    const custom: WorkspaceStatusDefinition[] = [
      ...STATUSES,
      { id: 'blocked', label: 'Blocked', color: 'rose', icon: 'ban' }
    ]
    const visible = visibleWith({
      filterWorkspaceStatuses: ['blocked'],
      workspaceStatuses: custom
    })

    expect(visible).toEqual([])
    // An empty list is only acceptable because Clear Filters can undo it.
    expect(
      sidebarHasActiveFilters({
        showSleepingWorkspaces: true,
        filterRepoIds: [],
        filterWorkspaceStatuses: ['blocked'],
        hideDefaultBranchWorkspace: false,
        hideAutomationGeneratedWorkspaces: false,
        hideCliCreatedWorkspaces: false,
        hideDetachedHeadWorkspaces: false,
        hideWorkspacesFromOtherDevices: false
      })
    ).toBe(true)
  })

  it('fails open when the catalog is missing, rather than collapsing to the default status', () => {
    // Why: a caller that forwards ids without the catalog would otherwise
    // resolve every row to the default id and silently show one status.
    expect(visibleWith({ filterWorkspaceStatuses: ['completed'] })).toEqual(sortedIds)
  })

  it('ignores a selected id that is not in the catalog instead of hiding everything', () => {
    // A stale id (deleted custom status) reaching the pipeline must not empty
    // the list on its own; it simply matches nothing beyond the live ids.
    expect(
      visibleWith({
        filterWorkspaceStatuses: ['deleted-custom', 'todo'],
        workspaceStatuses: STATUSES
      })
    ).toEqual(['wt-todo'])
  })

  it('intersects with the other sidebar filters rather than replacing them', () => {
    const archived = { ...makeWorktree('wt-archived', 'completed'), isArchived: true }
    const visible = computeVisibleWorktreeIds(
      { repo1: [...worktreesByRepo.repo1, archived] },
      [...sortedIds, 'wt-archived'],
      visibleOptions({ filterWorkspaceStatuses: ['completed'], workspaceStatuses: STATUSES })
    )

    expect(visible).toEqual(['wt-done'])
  })
})
