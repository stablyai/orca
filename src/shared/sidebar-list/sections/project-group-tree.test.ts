import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../project/groups/project-group-types'
import { walkProjectGroupTree } from './project-group-tree'
import { getProjectGroupOccurrencePaths } from './project-group-sections'

const baseGroup: ProjectGroup = {
  id: 'group-x',
  name: 'X',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

describe('project group tree', () => {
  it('keeps every group visible when same-id copies from two hosts close a parent loop', () => {
    // Each host is acyclic on its own; the drawn copies (Local X, Remote Y) loop X -> Y -> X.
    const groups: ProjectGroup[] = [
      { ...baseGroup, name: 'Local X', parentGroupId: 'group-y', executionHostId: 'local' },
      { ...baseGroup, id: 'group-y', name: 'Local Y', executionHostId: 'local' },
      {
        ...baseGroup,
        id: 'group-y',
        name: 'Remote Y',
        parentGroupId: 'group-x',
        executionHostId: 'runtime:env-1'
      }
    ]
    const headers: [string, number][] = []

    walkProjectGroupTree(
      {
        entries: [],
        projectGroups: groups,
        folderCountByGroupId: new Map(),
        projectOrderBy: 'manual',
        repoOrder: undefined
      },
      {
        group: (group, depth) => {
          headers.push([group.name, depth])
          return true
        },
        projects: () => {}
      }
    )

    expect(headers).toEqual([
      ['Local X', 0],
      ['Remote Y', 1]
    ])
    // Reveal walks the same parents the rows were drawn with.
    expect(getProjectGroupOccurrencePaths(groups).get('group-y')).toEqual({
      key: 'project-group:group-y',
      parent: { key: 'project-group:group-x', parent: undefined }
    })
  })
})
