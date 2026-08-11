import { describe, expect, it } from 'vitest'
import type { ProjectGroup, Repo } from '../../../../shared/types'
import { getProjectGroupDeletePreview } from './project-group-delete-preview'

const RUNTIME_HOST = 'runtime:env-1' as const

function group(name: string, source: 'local' | 'ssh:builder'): ProjectGroup {
  return {
    id: 'shared-group',
    name,
    parentPath: `/${name}`,
    connectionId: source === 'local' ? null : 'builder',
    executionHostId: RUNTIME_HOST,
    runtimeSourceExecutionHostId: source,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function repo(name: string, connectionId: string | null): Repo {
  return {
    id: `${name}-repo`,
    path: `/${name}`,
    displayName: name,
    badgeColor: '#000000',
    addedAt: 1,
    connectionId,
    executionHostId: RUNTIME_HOST,
    projectGroupId: 'shared-group'
  }
}

describe('project group delete preview', () => {
  it.each([
    ['forward', false],
    ['reverse', true]
  ])('counts only the selected physical owner in %s catalog order', (_label, reverse) => {
    const localGroup = group('local', 'local')
    const sshGroup = group('ssh', 'ssh:builder')
    const localRepo = repo('local', null)
    const sshRepo = repo('ssh', 'builder')
    const projectGroups = reverse ? [sshGroup, localGroup] : [localGroup, sshGroup]
    const repos = reverse ? [sshRepo, localRepo] : [localRepo, sshRepo]

    expect(
      getProjectGroupDeletePreview({
        groupId: localGroup.id,
        hostId: RUNTIME_HOST,
        sourceExecutionHostId: 'local',
        defaultHostId: 'local',
        projectGroups,
        repos
      })
    ).toMatchObject({
      groupExists: true,
      projectIds: [localRepo.id],
      projectNames: [localRepo.displayName]
    })
    expect(
      getProjectGroupDeletePreview({
        groupId: sshGroup.id,
        hostId: RUNTIME_HOST,
        sourceExecutionHostId: 'ssh:builder',
        defaultHostId: 'local',
        projectGroups,
        repos
      })
    ).toMatchObject({
      groupExists: true,
      projectIds: [sshRepo.id],
      projectNames: [sshRepo.displayName]
    })
  })

  it('omits contradictory repo owner metadata', () => {
    const localGroup = group('local', 'local')
    const invalidRepo = repo('invalid', 'builder')
    invalidRepo.executionHostId = 'local'

    expect(
      getProjectGroupDeletePreview({
        groupId: localGroup.id,
        hostId: RUNTIME_HOST,
        sourceExecutionHostId: 'local',
        defaultHostId: 'local',
        projectGroups: [localGroup],
        repos: [invalidRepo]
      }).projectIds
    ).toEqual([])
  })
})
