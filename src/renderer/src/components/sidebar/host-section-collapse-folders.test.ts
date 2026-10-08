import { expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { makeFolderWorkspace } from '../../store/slices/worktrees-slice-test-fixtures'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { buildRows } from './worktree-list/grouping/build-rows'
import { addHostSectionRows } from './host-section-rows'
import { scopeHostSectionCollapse } from './host-section-collapse'
import { getFolderWorkspaceRevealGroupKeys } from './worktree-list/navigation/folder-reveal'

const localGroup: ProjectGroup = {
  id: 'local-group',
  name: 'Local',
  parentPath: '/workspace/local',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}
const remoteGroup = { ...localGroup, id: 'remote-group', connectionId: 'builder' }
const local = makeFolderWorkspace({ id: 'local-folder', projectGroupId: localGroup.id })
const remote = makeFolderWorkspace({
  id: 'remote-folder',
  projectGroupId: remoteGroup.id,
  connectionId: 'builder'
})

for (const [groupBy, key] of [
  ['none', 'all'],
  ['workspace-status', 'workspace-status:in-progress'],
  ['pr-status', 'pr:in-progress']
] as const) {
  const rows = buildRows(
    groupBy,
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
    [localGroup, remoteGroup],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [local, remote]
  )
  const sectioned = addHostSectionRows({
    rows,
    hostOptions: [
      { id: 'local', kind: 'local', label: 'Local', detail: '', health: 'local' },
      { id: 'ssh:builder', kind: 'ssh', label: 'Remote', detail: '', health: 'available' }
    ],
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: ['local', 'ssh:builder'],
    defaultHostId: 'local'
  })

  it(`${groupBy}: collapses folder workspaces only on the owning host`, () => {
    const collapsed = scopeHostSectionCollapse({ rows: sectioned, collapsedGroups: new Set([key]) })
    expect(
      collapsed
        .filter((row) => row.type === 'folder-workspace')
        .map((row) => row.folderWorkspace.id)
    ).toEqual([remote.id])
    const remoteCollapsed = scopeHostSectionCollapse({
      rows: sectioned,
      collapsedGroups: new Set([`${key}:host:ssh:builder`])
    })
    expect(
      remoteCollapsed
        .filter((row) => row.type === 'folder-workspace')
        .map((row) => row.folderWorkspace.id)
    ).toEqual([local.id])
  })

  it(`${groupBy}: reveals a remote folder using the rendered host lane key`, () => {
    const keys = getFolderWorkspaceRevealGroupKeys(
      folderWorkspaceKey(remote.id),
      [local, remote],
      [localGroup, remoteGroup],
      {
        groupBy,
        defaultHostId: 'local',
        hostScopedGroups: true
      }
    )
    expect(keys).toContain(`${key}:host:ssh:builder`)
    expect(keys).toContain('host:ssh:builder')
    expect(keys).not.toContain(key)
    expect(
      getFolderWorkspaceRevealGroupKeys(folderWorkspaceKey(remote.id), [remote], [remoteGroup], {
        groupBy,
        defaultHostId: 'local'
      })
    ).toContain(key)
  })
}
