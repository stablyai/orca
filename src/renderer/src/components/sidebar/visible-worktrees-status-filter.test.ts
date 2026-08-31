import { describe, expect, it } from 'vitest'
import { computeVisibleWorktreeIds } from './visible-worktrees'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

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
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function makeRepo(id: string): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '#000', addedAt: 0 }
}

const repoMap = new Map<string, Repo>([
  ['repo1', makeRepo('repo1')],
  ['repo2', makeRepo('repo2')]
])

const statusCatalog = [
  { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' },
  {
    id: 'in-progress',
    label: 'In progress',
    color: 'conductor-progress',
    icon: 'conductor-progress'
  },
  { id: 'in-review', label: 'In review', color: 'conductor-review', icon: 'conductor-review' },
  { id: 'completed', label: 'Done', color: 'conductor-done', icon: 'conductor-done' }
]

type VisibleOptions = Parameters<typeof computeVisibleWorktreeIds>[2]

function visibleOptions(overrides: Partial<VisibleOptions> = {}): VisibleOptions {
  return {
    filterRepoIds: [],
    filterWorkspaceStatuses: [],
    workspaceStatuses: statusCatalog,
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

function withStatus(id: string, status: string | undefined, repoId = 'repo1'): Worktree {
  return { ...makeWorktree(id, repoId), workspaceStatus: status }
}

describe('computeVisibleWorktreeIds workspace-status filter', () => {
  it('shows every workspace when no status is selected', () => {
    const done = withStatus('done', 'completed')
    const wip = withStatus('wip', 'in-progress')

    const result = computeVisibleWorktreeIds(
      { repo1: [done, wip] },
      [done.id, wip.id],
      visibleOptions()
    )

    expect(result).toEqual([done.id, wip.id])
  })

  it('keeps only workspaces whose status is selected', () => {
    const done = withStatus('done', 'completed')
    const wip = withStatus('wip', 'in-progress')
    const todo = withStatus('todo', 'todo')

    const result = computeVisibleWorktreeIds(
      { repo1: [done, wip, todo] },
      [done.id, wip.id, todo.id],
      visibleOptions({ filterWorkspaceStatuses: ['completed'] })
    )

    expect(result).toEqual([done.id])
  })

  it('supports selecting multiple statuses ("not completed" = todo + in-progress + in-review)', () => {
    const done = withStatus('done', 'completed')
    const wip = withStatus('wip', 'in-progress')
    const review = withStatus('review', 'in-review')
    const todo = withStatus('todo', 'todo')

    const result = computeVisibleWorktreeIds(
      { repo1: [done, wip, review, todo] },
      [done.id, wip.id, review.id, todo.id],
      visibleOptions({ filterWorkspaceStatuses: ['todo', 'in-progress', 'in-review'] })
    )

    expect(result).toEqual([wip.id, review.id, todo.id])
  })

  it('treats an unset workspaceStatus as the catalog default (in-progress)', () => {
    // A never-touched workspace resolves to the default id, so a filter for the
    // default surfaces it even though the field is undefined.
    const untouched = withStatus('untouched', undefined)
    const done = withStatus('done', 'completed')

    const result = computeVisibleWorktreeIds(
      { repo1: [untouched, done] },
      [untouched.id, done.id],
      visibleOptions({ filterWorkspaceStatuses: ['in-progress'] })
    )

    expect(result).toEqual([untouched.id])
  })

  it('combines with the repo filter (both must pass)', () => {
    const repo1Done = withStatus('r1-done', 'completed', 'repo1')
    const repo2Done = withStatus('r2-done', 'completed', 'repo2')

    const result = computeVisibleWorktreeIds(
      { repo1: [repo1Done], repo2: [repo2Done] },
      [repo1Done.id, repo2Done.id],
      visibleOptions({ filterRepoIds: ['repo1'], filterWorkspaceStatuses: ['completed'] })
    )

    expect(result).toEqual([repo1Done.id])
  })

  it('fails open: a selected status with no loaded catalog keeps every workspace', () => {
    // Before the catalog loads every row resolves to the fallback status, so
    // applying the filter would wrongly hide a non-default selection.
    const done = withStatus('done', 'completed')
    const wip = withStatus('wip', 'in-progress')

    const result = computeVisibleWorktreeIds(
      { repo1: [done, wip] },
      [done.id, wip.id],
      visibleOptions({ filterWorkspaceStatuses: ['completed'], workspaceStatuses: undefined })
    )

    expect(result).toEqual([done.id, wip.id])
  })
})
