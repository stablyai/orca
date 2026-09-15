import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { addHostSectionRows, type HostSectionOption } from './host-section-rows'
import { buildRows } from './worktree-list/grouping/build-rows'
import { repo, worktree, remoteRepo, remoteWorktree } from './worktree-list-groups-test-fixtures'

const hostOptions: HostSectionOption[] = [
  { id: 'local', kind: 'local', label: 'Local Mac', detail: '', health: 'local' },
  { id: 'ssh:gpu-vm', kind: 'ssh', label: 'SSH', detail: '', health: 'available' },
  {
    id: 'runtime:test-server',
    kind: 'runtime',
    label: 'test-server',
    detail: '',
    health: 'available'
  }
]

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

describe('host sections with project groups', () => {
  it.each([false, true])('keeps local groups under Local Mac (collapsed: %s)', (collapsed) => {
    const groups = ['tidb_dev', 'rc', 'ob9'].map((id, tabOrder) => group(id, { tabOrder }))
    const groupedRepo = { ...repo, projectGroupId: 'ob9' }
    const rows = buildRows(
      'repo',
      [worktree, remoteWorktree],
      new Map([
        [repo.id, groupedRepo],
        [remoteRepo.id, remoteRepo]
      ]),
      null,
      new Set(collapsed ? ['project-group:ob9'] : []),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      groups
    )
    const sectioned = addHostSectionRows({
      rows,
      hostOptions,
      workspaceHostScope: 'all',
      defaultHostId: 'local'
    })
    let hostId: string | undefined
    const owners: [string, string | undefined][] = []
    for (const row of sectioned) {
      if (row.type === 'host-header') {
        hostId = row.hostId
      }
      if (row.type === 'header' && row.projectGroup) {
        owners.push([row.label, hostId])
      }
    }
    expect(owners).toEqual(groups.map((entry) => [entry.name, 'local']))
    const remoteIndex = sectioned.findIndex(
      (row) => row.type === 'host-header' && row.hostId === 'ssh:gpu-vm'
    )
    expect(sectioned.slice(remoteIndex + 1)).toEqual(
      rows.filter(
        (row) => (row.type === 'header' || row.type === 'item') && row.repo?.id === remoteRepo.id
      )
    )
    const collapsedHostRows = addHostSectionRows({
      rows,
      hostOptions,
      workspaceHostScope: 'all',
      defaultHostId: 'local',
      collapsedHostKeys: new Set(['host:local'])
    })
    expect(collapsedHostRows.some((row) => row.type === 'header' && row.projectGroup)).toBe(false)
  })

  it('routes empty nested groups using their host identity, including the default runtime', () => {
    const groups = [
      group('local', { executionHostId: 'local' }),
      group('child', { executionHostId: 'local', parentGroupId: 'local' }),
      group('ssh', { connectionId: 'gpu-vm' }),
      group('runtime', { executionHostId: 'runtime:test-server', connectionId: 'gpu-vm' }),
      group('default')
    ]
    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      groups
    )
    const sectioned = addHostSectionRows({
      rows,
      hostOptions,
      workspaceHostScope: 'all',
      defaultHostId: 'runtime:test-server'
    })
    expect(sectioned.map((row) => ('key' in row ? row.key : ''))).toEqual([
      'host:local',
      'project-group:local',
      'project-group:child',
      'host:ssh:gpu-vm',
      'project-group:ssh',
      'host:runtime:test-server',
      'project-group:default',
      'project-group:runtime'
    ])
    expect(sectioned.find((row) => row.type === 'header' && row.label === 'child')).toMatchObject({
      projectGroupDepth: 1
    })
  })

  it('keeps a folder workspace and its group together before an ungrouped SSH repo', () => {
    const projectGroup = group('folder', { parentPath: '/projects', createdFrom: 'folder-scan' })
    const folderWorkspace: FolderWorkspace = {
      id: 'folder-1',
      projectGroupId: projectGroup.id,
      name: 'Notes',
      folderPath: '/projects/notes',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1
    }
    const rows = buildRows(
      'repo',
      [remoteWorktree],
      new Map([[remoteRepo.id, remoteRepo]]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [projectGroup],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [folderWorkspace]
    )
    const sectioned = addHostSectionRows({
      rows,
      hostOptions,
      workspaceHostScope: 'all',
      defaultHostId: 'local'
    })
    expect(sectioned.slice(0, 4)).toMatchObject([
      { type: 'host-header', hostId: 'local' },
      { type: 'header', projectGroup },
      { type: 'folder-workspace', folderWorkspace, groupDepth: 1 },
      { type: 'host-header', hostId: 'ssh:gpu-vm' }
    ])
    expect(sectioned.filter((row) => row.type === 'header' && row.projectGroup)).toHaveLength(1)
  })
})
