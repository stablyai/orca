import { describe, expect, it } from 'vitest'
import { computeVisibleWorktreeIds } from './visible-worktrees'
import { getEmptyProjectPlaceholderRepoIds } from './empty-project-placeholder-repos'
import { someRepoHidesWhenIdle } from './repo-idle-visibility'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '#000', addedAt: 0, ...overrides }
}

function makeMainWorktree(repoId: string): Worktree {
  return {
    id: `${repoId}::/${repoId}`,
    repoId,
    path: `/${repoId}`,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'main',
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

type VisibleOptions = Parameters<typeof computeVisibleWorktreeIds>[2]

const idleClone = makeRepo('clone-idle', { hideWhenIdle: true })
const busyClone = makeRepo('clone-busy', { hideWhenIdle: true })
const ordinary = makeRepo('ordinary')
const repoMap = new Map<string, Repo>(
  [idleClone, busyClone, ordinary].map((repo) => [repo.id, repo])
)
const worktreesByRepo = {
  [idleClone.id]: [makeMainWorktree(idleClone.id)],
  [busyClone.id]: [makeMainWorktree(busyClone.id)],
  [ordinary.id]: [makeMainWorktree(ordinary.id)]
}
const allIds = Object.values(worktreesByRepo).flatMap((worktrees) => worktrees.map((w) => w.id))
const busyId = worktreesByRepo[busyClone.id][0].id
const idleId = worktreesByRepo[idleClone.id][0].id
const ordinaryId = worktreesByRepo[ordinary.id][0].id

function visibleOptions(overrides: Partial<VisibleOptions> = {}): VisibleOptions {
  return {
    filterRepoIds: [],
    showSleepingWorkspaces: true,
    // Only the busy clone has a live terminal.
    tabsByWorktree: { [busyId]: [{ id: 'tab-1' }] },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
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

describe('per-repo "Hide when idle"', () => {
  it('hides an opted-in idle main checkout while "Hide sleeping" is off', () => {
    expect(computeVisibleWorktreeIds(worktreesByRepo, allIds, visibleOptions())).toEqual([
      busyId,
      ordinaryId
    ])
  })

  it('overrides the main-checkout exemption of the global "Hide sleeping" filter', () => {
    const visible = computeVisibleWorktreeIds(
      worktreesByRepo,
      allIds,
      visibleOptions({ showSleepingWorkspaces: false, alwaysShowDefaultBranchWorkspace: true })
    )
    expect(visible).toEqual([busyId, ordinaryId])
  })

  it('keeps the open workspace visible before its first terminal starts', () => {
    const visible = computeVisibleWorktreeIds(
      worktreesByRepo,
      allIds,
      visibleOptions({ activeWorktreeId: idleId })
    )
    expect(visible).toEqual(allIds)
  })

  it('treats a browser tab, live agent or structured chat as activity', () => {
    for (const overrides of [
      { browserTabsByWorktree: { [idleId]: [{ id: 'browser-1' }] } },
      { worktreeIdsWithLiveAgent: new Set([idleId]) },
      { worktreeIdsWithStructuredChat: new Set([idleId]) }
    ]) {
      expect(computeVisibleWorktreeIds(worktreesByRepo, allIds, visibleOptions(overrides))).toEqual(
        allIds
      )
    }
  })

  it('shows every row when the caller did not collect activity', () => {
    const visible = computeVisibleWorktreeIds(
      worktreesByRepo,
      allIds,
      visibleOptions({ tabsByWorktree: null, ptyIdsByTabId: null })
    )
    expect(visible).toEqual(allIds)
  })

  it('reports whether any repo opted in, so hooks know to collect activity', () => {
    expect(someRepoHidesWhenIdle(repoMap)).toBe(true)
    expect(someRepoHidesWhenIdle(new Map([[ordinary.id, ordinary]]))).toBe(false)
  })
})

describe('project-group placeholders for "Hide when idle" repos', () => {
  it('drops the empty header of an idle opted-in group member but keeps other filtered members', () => {
    const grouped = [
      { ...idleClone, projectGroupId: 'group-1' },
      makeRepo('grouped-filtered', { projectGroupId: 'group-1' })
    ]
    const placeholders = getEmptyProjectPlaceholderRepoIds({
      groupBy: 'repo',
      repos: grouped,
      worktreesByRepo: {
        [idleClone.id]: worktreesByRepo[idleClone.id],
        'grouped-filtered': [makeMainWorktree('grouped-filtered')]
      },
      visibleWorktrees: [],
      filterRepoIds: []
    })
    expect(Array.from(placeholders)).toEqual(['grouped-filtered'])
  })
})
