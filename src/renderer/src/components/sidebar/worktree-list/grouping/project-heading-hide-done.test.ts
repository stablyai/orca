import { describe, expect, it } from 'vitest'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import { getEmptyProjectPlaceholderRepoIds } from '../../../../../../shared/sidebar-list/catalog/empty-project-placeholder-repos'
import { buildProjectSections } from '../../../../../../shared/sidebar-list/sections/project-section-grouping'
import { indexHiddenProjects } from '../../../../../../shared/project/catalog/hidden-projects'

const repos = [{ ...makeRepo(), projectGroupId: 'group-1' }]
const repo = repos[0]
const done = makeWorktree('done-workspace', 'Done workspace', {
  repoId: repo.id,
  workspaceStatus: 'completed'
})
const repoMap = new Map([[repo.id, repo]])

function placeholders(hideDoneWorkspaces: boolean): Set<string> {
  return getEmptyProjectPlaceholderRepoIds({
    groupBy: 'repo',
    repos,
    worktreesByRepo: { [repo.id]: [done] },
    visibleWorktrees: [],
    filterRepoIds: [],
    hiddenProjects: indexHiddenProjects(repos, 'local'),
    hideDoneWorkspaces
  })
}

function headings(hideDoneWorkspaces: boolean): string[] {
  return buildProjectSections({
    items: [],
    repoIdOf: () => '',
    repoMap,
    projectIndex: null,
    placeholderRepoIds: placeholders(hideDoneWorkspaces),
    repoOrder: undefined,
    projectOrderBy: 'manual'
  }).map(([key]) => key)
}

describe('Hide Done project headings', () => {
  it('does not open a heading for a grouped project whose only workspaces are Done', () => {
    expect(placeholders(true)).toEqual(new Set())
    expect(headings(true)).toEqual([])
  })

  it('keeps the heading when Hide Done is off', () => {
    expect(placeholders(false)).toEqual(new Set([repo.id]))
    expect(headings(false)).toHaveLength(1)
  })

  it('keeps the heading for a project with no worktrees even when Hide Done is on', () => {
    const placeholders = getEmptyProjectPlaceholderRepoIds({
      groupBy: 'repo',
      repos,
      worktreesByRepo: {},
      visibleWorktrees: [],
      filterRepoIds: [],
      hiddenProjects: indexHiddenProjects(repos, 'local'),
      hideDoneWorkspaces: true
    })
    expect(placeholders).toEqual(new Set([repo.id]))
  })
})
