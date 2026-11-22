import type {
  HostSectionRow,
  HostHeaderRow
} from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  getRootProjectHeaderCountByOccurrenceKey,
  getRootProjectHeaderDragKeys,
  getSidebarRootProjectHeaderKeys
} from './root-project-header-drop'

function group(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
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

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '', addedAt: 1, ...overrides }
}

describe('root project header drops', () => {
  it('limits root moves to the source host section', () => {
    expect(
      getRootProjectHeaderDragKeys(
        [
          'group:global',
          'host:local',
          'group:a',
          'repo:x',
          'host:runtime:remote',
          'group:b',
          'repo:y'
        ],
        'repo:x'
      )
    ).toEqual(['group:a', 'repo:x'])
    expect(
      getRootProjectHeaderDragKeys(
        ['host:local', 'group:a', 'host:runtime:remote', 'repo:y'],
        'group:a'
      )
    ).toEqual(['group:a'])
  })

  it('uses the actual host occurrence when repeated logical headers span sections', () => {
    const host = (hostId: HostHeaderRow['hostId']): HostHeaderRow => ({
      type: 'host-header',
      key: hostId,
      hostId,
      kind: hostId === 'local' ? 'local' : 'runtime',
      label: hostId,
      detail: '',
      health: 'available',
      collapsed: false,
      count: 1
    })
    const rows: HostSectionRow[] = [
      host('local'),
      {
        type: 'header',
        key: 'group:a',
        count: 1,
        icon: { kind: 'project' },
        projectGroup: group('a'),
        hostId: 'local'
      },
      {
        type: 'header',
        key: 'repo:x',
        count: 1,
        icon: { kind: 'project' },
        repo: repo('x'),
        hostId: 'local'
      },
      host('runtime:remote'),
      {
        type: 'header',
        key: 'group:a',
        count: 1,
        icon: { kind: 'project' },
        projectGroup: group('a'),
        hostId: 'runtime:remote',
        repeated: true
      },
      {
        type: 'header',
        key: 'repo:remote-x',
        count: 1,
        icon: { kind: 'project' },
        repo: repo('remote-x', { executionHostId: 'runtime:remote' }),
        anchorRepo: repo('x'),
        hostId: 'runtime:remote',
        repeated: true
      },
      {
        type: 'header',
        key: 'repo:y',
        count: 1,
        icon: { kind: 'project' },
        repo: repo('y'),
        hostId: 'runtime:remote'
      }
    ]
    const keys = getSidebarRootProjectHeaderKeys(rows)
    expect(keys).toEqual([
      'host:local',
      'group:a',
      'repo:x',
      'host:runtime:remote',
      'group:a',
      'repo:x',
      'repo:y'
    ])
    expect(getRootProjectHeaderDragKeys(keys, 'group:a', 'runtime:remote')).toEqual([
      'group:a',
      'repo:x',
      'repo:y'
    ])
    expect(getRootProjectHeaderDragKeys(keys, 'repo:y', 'local')).toBeUndefined()
    expect([...getRootProjectHeaderCountByOccurrenceKey(keys)]).toEqual([
      ['["local","group:a"]', 2],
      ['["local","repo:x"]', 2],
      ['["runtime:remote","group:a"]', 3],
      ['["runtime:remote","repo:x"]', 3],
      ['["runtime:remote","repo:y"]', 3]
    ])
  })
})
