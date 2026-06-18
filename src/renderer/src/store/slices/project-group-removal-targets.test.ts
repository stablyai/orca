import { describe, expect, it } from 'vitest'
import type { ProjectGroup, Repo } from '../../../../shared/types'
import { selectProjectGroupRemovalTargets } from './project-group-removal-targets'

const rootGroup: ProjectGroup = {
  id: 'root',
  name: 'Root',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const childGroup: ProjectGroup = {
  ...rootGroup,
  id: 'child',
  name: 'Child',
  parentGroupId: rootGroup.id,
  tabOrder: 1
}

const siblingGroup: ProjectGroup = {
  ...rootGroup,
  id: 'sibling',
  name: 'Sibling',
  tabOrder: 2
}

function makeRepo(id: string, projectGroupId: string | null): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    projectGroupId
  }
}

describe('selectProjectGroupRemovalTargets', () => {
  it('selects direct and nested child projects in repo order', () => {
    const result = selectProjectGroupRemovalTargets(
      [rootGroup, childGroup, siblingGroup],
      [
        makeRepo('direct', rootGroup.id),
        makeRepo('nested', childGroup.id),
        makeRepo('sibling', siblingGroup.id),
        makeRepo('ungrouped', null)
      ],
      rootGroup.id
    )

    expect(result.groupExists).toBe(true)
    expect([...result.deletedGroupIds].sort()).toEqual([childGroup.id, rootGroup.id])
    expect(result.projectIds).toEqual(['direct', 'nested'])
  })

  it('returns an empty project list for empty groups', () => {
    const result = selectProjectGroupRemovalTargets([rootGroup], [], rootGroup.id)

    expect(result.groupExists).toBe(true)
    expect([...result.deletedGroupIds]).toEqual([rootGroup.id])
    expect(result.projectIds).toEqual([])
  })

  it('does not synthesize targets for a missing group', () => {
    const result = selectProjectGroupRemovalTargets(
      [rootGroup],
      [makeRepo('direct', rootGroup.id)],
      'missing'
    )

    expect(result.groupExists).toBe(false)
    expect([...result.deletedGroupIds]).toEqual([])
    expect(result.projectIds).toEqual([])
  })
})
