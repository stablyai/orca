import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  filterProjectGroupsForRepo,
  hasMultipleProjectGroupCatalogHosts
} from './project-group-owner-routing'

const baseGroup: ProjectGroup = {
  id: 'group',
  name: 'Group',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const baseRepo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#111',
  addedAt: 1
}

describe('project groups available to a repo', () => {
  it('offers a paired repo only groups from the same runtime host', () => {
    const repo = { ...baseRepo, executionHostId: 'runtime:env-1' as const }
    const localGroup = { ...baseGroup, id: 'local', executionHostId: 'local' as const }
    const owningRuntimeGroup = {
      ...baseGroup,
      id: 'runtime-1',
      executionHostId: 'runtime:env-1' as const
    }
    const otherRuntimeGroup = {
      ...baseGroup,
      id: 'runtime-2',
      executionHostId: 'runtime:env-2' as const
    }

    expect(
      filterProjectGroupsForRepo([localGroup, owningRuntimeGroup, otherRuntimeGroup], repo)
    ).toEqual([owningRuntimeGroup])
  })

  it('keeps direct-SSH repos compatible with the client-owned catalog', () => {
    const repo = { ...baseRepo, connectionId: 'ssh-1' }
    const localGroup = { ...baseGroup, executionHostId: 'local' as const }

    expect(filterProjectGroupsForRepo([localGroup], repo)).toEqual([localGroup])
  })

  it('keeps direct-SSH-stamped groups in the client-owned catalog', () => {
    const repo = { ...baseRepo, connectionId: 'ssh-1' }
    const otherSshGroup = { ...baseGroup, connectionId: 'ssh-2' }

    expect(filterProjectGroupsForRepo([otherSshGroup], repo)).toEqual([otherSshGroup])
  })

  it('requires host labels only when projects span group catalogs', () => {
    const localRepo = { ...baseRepo, executionHostId: 'local' as const }
    const directSshRepo = { ...baseRepo, id: 'ssh', connectionId: 'workstation' }
    const workRepo = { ...baseRepo, id: 'work', executionHostId: 'runtime:work' as const }
    const homeRepo = { ...baseRepo, id: 'home', executionHostId: 'runtime:home' as const }

    expect(hasMultipleProjectGroupCatalogHosts([localRepo, directSshRepo])).toBe(false)
    expect(hasMultipleProjectGroupCatalogHosts([workRepo])).toBe(false)
    expect(hasMultipleProjectGroupCatalogHosts([workRepo, homeRepo])).toBe(true)
    expect(hasMultipleProjectGroupCatalogHosts([localRepo, workRepo])).toBe(true)
  })
})
