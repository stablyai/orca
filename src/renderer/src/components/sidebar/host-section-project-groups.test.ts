import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { addHostSectionRows, type HostSectionOption } from './host-section-rows'
import { buildRows } from './worktree-list/grouping/build-rows'
import { repo, worktree, remoteRepo, remoteWorktree } from './worktree-list-groups-test-fixtures'
import {
  getLaneHostWorktreeCounts,
  getLaneHostWorktreeIds
} from './worktree-list/grouping/host-labels'
import { getFolderWorkspaceRevealGroupKeys } from './worktree-list/navigation/folder-reveal'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

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

/** Unstamped defaults exercise legacy groups that inherit the active host. */
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

  it.each([
    { executionHostId: undefined, stampWorkspace: false, expectedHostId: 'local' },
    {
      executionHostId: 'runtime:test-server' as const,
      stampWorkspace: true,
      expectedHostId: 'runtime:test-server'
    },
    {
      executionHostId: 'runtime:test-server' as const,
      stampWorkspace: false,
      expectedHostId: 'runtime:test-server'
    }
  ])(
    'keeps folder groups and children together: %j',
    ({ executionHostId, stampWorkspace, expectedHostId }) => {
      const projectGroup = group('folder', {
        parentPath: '/projects',
        createdFrom: 'folder-scan',
        executionHostId
      })
      const folderWorkspace: FolderWorkspace = {
        id: 'folder-1',
        executionHostId: stampWorkspace ? executionHostId : undefined,
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
      const hostIndex = sectioned.findIndex(
        (row) => row.type === 'host-header' && row.hostId === expectedHostId
      )
      expect(hostIndex).toBeGreaterThanOrEqual(0)
      expect(sectioned.slice(hostIndex, hostIndex + 3)).toMatchObject([
        { type: 'host-header', hostId: expectedHostId, count: 1 },
        { type: 'header', projectGroup },
        { type: 'folder-workspace', folderWorkspace, groupDepth: 1 }
      ])
      expect(sectioned.filter((row) => row.type === 'header' && row.projectGroup)).toHaveLength(1)
      const folderPairs = [{ folderWorkspace, projectGroup }]
      expect(getLaneHostWorktreeCounts([], folderPairs, new Map(), 'local')).toEqual(
        new Map([[expectedHostId, 1]])
      )
      expect(getLaneHostWorktreeIds([], folderPairs, new Map(), 'local')).toEqual(
        new Map([[expectedHostId, []]])
      )
      expect(
        getFolderWorkspaceRevealGroupKeys(
          folderWorkspaceKey(folderWorkspace.id),
          [folderWorkspace],
          [projectGroup],
          { groupBy: 'repo', defaultHostId: 'local' }
        )
      ).toEqual(['project-group:folder', `host:${expectedHostId}`])
      const collapsedRows = addHostSectionRows({
        rows,
        hostOptions,
        workspaceHostScope: 'all',
        defaultHostId: 'local',
        collapsedHostKeys: new Set([`host:${expectedHostId}`])
      })
      expect(
        collapsedRows.some(
          (row) => row.type === 'folder-workspace' || (row.type === 'header' && row.projectGroup)
        )
      ).toBe(false)
    }
  )
})
