import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { repo as baseRepo } from '../../worktree-list-groups-test-fixtures'
import { filterProjectGroupsForRepoFilter } from './project-filter-group-scope'

function group(overrides: Partial<ProjectGroup> & Pick<ProjectGroup, 'id'>): ProjectGroup {
  return {
    name: overrides.id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function repo(id: string, projectGroupId: string | null): Repo {
  return { ...baseRepo, id, displayName: id, path: `/repos/${id}`, projectGroupId }
}

const platform = group({ id: 'platform' })
const platformApi = group({ id: 'platform-api', parentGroupId: 'platform' })
const tooling = group({ id: 'tooling' })
const emptyGroup = group({ id: 'empty' })
const groups = [platform, platformApi, tooling, emptyGroup]
const repos = [
  repo('api', 'platform-api'),
  repo('web', 'platform'),
  repo('cli', 'tooling'),
  repo('loose', null)
]

describe('filterProjectGroupsForRepoFilter', () => {
  it('returns every group unchanged when no project filter is active', () => {
    expect(filterProjectGroupsForRepoFilter(groups, repos, [])).toBe(groups)
  })

  it('hides groups with no selected repo in their subtree', () => {
    expect(filterProjectGroupsForRepoFilter(groups, repos, ['cli'])).toEqual([tooling])
  })

  it('keeps ancestor groups above a nested match', () => {
    expect(filterProjectGroupsForRepoFilter(groups, repos, ['api'])).toEqual([
      platform,
      platformApi
    ])
  })

  it('does not keep sibling subgroups of a match', () => {
    expect(filterProjectGroupsForRepoFilter(groups, repos, ['web'])).toEqual([platform])
  })

  it('hides every group when only ungrouped repos are selected', () => {
    expect(filterProjectGroupsForRepoFilter(groups, repos, ['loose'])).toEqual([])
  })

  it('ignores a selected repo whose group metadata is missing', () => {
    expect(
      filterProjectGroupsForRepoFilter(groups, [repo('orphan', 'missing-group')], ['orphan'])
    ).toEqual([])
  })

  it('preserves the original group order', () => {
    expect(filterProjectGroupsForRepoFilter(groups, repos, ['cli', 'api'])).toEqual([
      platform,
      platformApi,
      tooling
    ])
  })
})
