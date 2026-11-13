import { describe, expect, it } from 'vitest'
import { hiddenProjectRowFacts, indexHiddenProjects } from './hidden-projects'
import { getEmptyProjectPlaceholderRepoIds } from './sidebar-list/empty-project-placeholder-repos'
import type { Repo } from './repo-types'
import {
  filterWorkspaceRows,
  NO_WORKSPACE_ROW_FILTERS,
  type WorkspaceRowFactReader
} from './workspace-view/workspace-row-filters'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '', addedAt: 0, ...overrides }
}

type Row = { repoId: string; hostId?: string }

const readerFacts: Omit<WorkspaceRowFactReader<Row>, 'isInHiddenProject' | 'isProjectHidden'> = {
  isArchived: () => false,
  isFolderWorkspace: () => false,
  repoId: (row) => row.repoId,
  hostId: () => 'local',
  isOtherClient: () => false,
  isDefaultBranch: () => false,
  isAutomationCreated: () => false,
  isCliCreated: () => false,
  isDetachedHead: () => false,
  isMainWorktree: () => false,
  isSleeping: () => false
}

describe('indexHiddenProjects', () => {
  it('ignores a filter id only while every loaded copy is hidden, so a partial catalog writes nothing', () => {
    const filters = Object.freeze({ ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: ['r'] })
    const rows: Row[] = [{ repoId: 'r', hostId: 'ssh:box' }, { repoId: 'other' }]
    const reader = (repos: Repo[]): WorkspaceRowFactReader<Row> => {
      const hidden = indexHiddenProjects(repos, 'local')
      return { ...readerFacts, ...hiddenProjectRowFacts(hidden) }
    }
    // Startup: only the local copy, which is hidden, has loaded; the filter is ignored, not erased.
    const partial = [repo('r', { hiddenAt: 1 }), repo('other')]
    expect(filterWorkspaceRows(rows, filters, reader(partial))).toEqual(rows)
    expect(
      getEmptyProjectPlaceholderRepoIds({
        groupBy: 'repo',
        repos: partial,
        worktreesByRepo: {},
        visibleWorktrees: [],
        filterRepoIds: filters.filterRepoIds,
        hiddenProjects: indexHiddenProjects(partial, 'local')
      })
    ).toEqual(new Set(['other']))
    // The box's listed copy arrives: the same, untouched filter applies again.
    const loaded = [...partial, repo('r', { connectionId: 'box' })]
    expect(filterWorkspaceRows(rows, filters, reader(loaded))).toEqual([
      { repoId: 'r', hostId: 'ssh:box' }
    ])
    expect(filters.filterRepoIds).toEqual(['r'])
  })
})
