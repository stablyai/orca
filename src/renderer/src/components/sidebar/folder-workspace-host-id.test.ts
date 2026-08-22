import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { getFolderWorkspaceHostId } from './folder-workspace-host-id'
import { addHostSectionRows, type HostSectionOption } from './host-section-rows'
import type { Row } from './worktree-list/grouping/row-types'

const OWNER_HOST_ID: ExecutionHostId = 'runtime:owner'
const FOCUSED_HOST_ID: ExecutionHostId = 'runtime:focused'

function folderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-same-id',
    projectGroupId: 'group-same-id',
    name: 'Folder workspace',
    folderPath: '/workspace/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function projectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-same-id',
    name: 'Folder group',
    parentPath: '/workspace',
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

function folderRow(
  workspace: FolderWorkspace,
  group: ProjectGroup
): Extract<Row, { type: 'folder-workspace' }> {
  return {
    type: 'folder-workspace',
    key: `folder-workspace:${workspace.id}`,
    folderWorkspace: workspace,
    projectGroup: group,
    depth: 0,
    groupDepth: 0
  }
}

function hostOption(id: ExecutionHostId): HostSectionOption {
  return {
    id,
    kind: id === 'local' ? 'local' : id.startsWith('ssh:') ? 'ssh' : 'runtime',
    label: id,
    detail: 'Host',
    health: id === 'local' ? 'local' : 'available'
  }
}

function folderPlacements(rows: ReturnType<typeof addHostSectionRows>): string[] {
  let hostId: ExecutionHostId | null = null
  const placements: string[] = []
  for (const row of rows) {
    if (row.type === 'host-header') {
      hostId = row.hostId
    } else if (row.type === 'folder-workspace') {
      placements.push(`${row.folderWorkspace.executionHostId ?? 'legacy'}@${hostId ?? 'none'}`)
    }
  }
  return placements
}

describe('folder workspace host resolution', () => {
  it.each([
    {
      name: 'workspace executionHostId',
      workspace: { executionHostId: OWNER_HOST_ID },
      group: {},
      expected: OWNER_HOST_ID
    },
    {
      name: 'legacy workspace connectionId',
      workspace: { connectionId: 'legacy-target' },
      group: {},
      expected: 'ssh:legacy-target'
    },
    {
      name: 'executionHostId with connectionId',
      workspace: { executionHostId: OWNER_HOST_ID, connectionId: 'legacy-target' },
      group: {},
      expected: OWNER_HOST_ID
    },
    {
      name: 'workspace executionHostId over conflicting group executionHostId',
      workspace: { executionHostId: 'local' as const },
      group: { executionHostId: OWNER_HOST_ID },
      expected: 'local'
    },
    {
      name: 'neither authoritative field',
      workspace: {},
      group: {},
      expected: FOCUSED_HOST_ID
    },
    {
      name: 'project group executionHostId',
      workspace: {},
      group: { executionHostId: OWNER_HOST_ID },
      expected: OWNER_HOST_ID
    },
    {
      name: 'legacy project group connectionId',
      workspace: {},
      group: { connectionId: 'legacy-target' },
      expected: 'ssh:legacy-target'
    },
    {
      name: 'new group owner with legacy workspace connectionId',
      workspace: { connectionId: 'legacy-target' },
      group: { executionHostId: OWNER_HOST_ID },
      expected: OWNER_HOST_ID
    }
  ])('resolves $name', ({ workspace, group, expected }) => {
    expect(
      getFolderWorkspaceHostId(folderWorkspace(workspace), projectGroup(group), FOCUSED_HOST_ID)
    ).toBe(expected)
  })

  it('does not change an authoritative owner when focus changes', () => {
    const workspace = folderWorkspace({ executionHostId: OWNER_HOST_ID })
    const group = projectGroup({ executionHostId: OWNER_HOST_ID })

    expect(getFolderWorkspaceHostId(workspace, group, 'local')).toBe(OWNER_HOST_ID)
    expect(getFolderWorkspaceHostId(workspace, group, FOCUSED_HOST_ID)).toBe(OWNER_HOST_ID)
  })

  it('keeps colliding workspace IDs partitioned through disconnect and reconnect', () => {
    const localRow = folderRow(
      folderWorkspace({ executionHostId: 'local', folderPath: '/local/folder' }),
      projectGroup({ executionHostId: 'local', parentPath: '/local' })
    )
    const ownerRow = folderRow(
      folderWorkspace({ executionHostId: OWNER_HOST_ID, folderPath: '/owner/folder' }),
      projectGroup({ executionHostId: OWNER_HOST_ID, parentPath: '/owner' })
    )
    const common = {
      rows: [localRow, ownerRow],
      workspaceHostScope: 'all' as const,
      defaultHostId: FOCUSED_HOST_ID
    }

    const connected = addHostSectionRows({
      ...common,
      hostOptions: [hostOption('local'), hostOption(OWNER_HOST_ID), hostOption(FOCUSED_HOST_ID)]
    })
    const disconnected = addHostSectionRows({
      ...common,
      hostOptions: [hostOption('local'), hostOption(FOCUSED_HOST_ID)]
    })
    const reconnected = addHostSectionRows({
      ...common,
      hostOptions: [hostOption('local'), hostOption(OWNER_HOST_ID), hostOption(FOCUSED_HOST_ID)]
    })

    const expected = ['local@local', `${OWNER_HOST_ID}@${OWNER_HOST_ID}`]
    expect(folderPlacements(connected)).toEqual(expected)
    expect(folderPlacements(disconnected)).toEqual(expected)
    expect(folderPlacements(reconnected)).toEqual(expected)
  })
})
