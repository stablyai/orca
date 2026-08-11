import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
import type { Row } from './worktree-list-groups'
import { addHostSectionRows } from './host-section-rows'

function group(connectionId: string | null): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Group',
    parentPath: '/workspace',
    parentGroupId: null,
    connectionId,
    executionHostId: connectionId ? 'ssh:ssh-1' : 'local',
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function folderRow(
  id: string,
  connectionId: string | null,
  projectGroup: ProjectGroup
): Extract<Row, { type: 'folder-workspace' }> {
  const folderWorkspace: FolderWorkspace = {
    id,
    projectGroupId: projectGroup.id,
    name: id,
    folderPath: `/workspace/${id}`,
    connectionId,
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
  return {
    type: 'folder-workspace',
    key: `folder-workspace:${id}`,
    folderWorkspace,
    projectGroup,
    depth: 0,
    groupDepth: 0
  }
}

describe('folder owner host sections', () => {
  it('keeps an explicit-local folder under local despite its SSH project group', () => {
    const sshGroup = group('ssh-1')
    const rows = [
      folderRow('local-folder', null, sshGroup),
      folderRow('ssh-folder', 'ssh-1', sshGroup)
    ]
    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        { id: 'local', kind: 'local', label: 'Local', detail: 'This computer', health: 'local' },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local'
    })

    expect(sectioned.map((row) => ('key' in row ? row.key : null))).toEqual([
      'host:local',
      'folder-workspace:local-folder',
      'host:ssh:ssh-1',
      'folder-workspace:ssh-folder'
    ])
  })
})
