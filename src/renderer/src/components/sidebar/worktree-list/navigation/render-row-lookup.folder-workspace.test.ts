import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { RenderRow } from '../listing/render-row'
import { findPreferredRenderRowIndexForWorktreeIdentity } from './render-row-lookup'

const FOLDER_WORKSPACE: FolderWorkspace = {
  id: 'fw-1',
  projectGroupId: 'group-1',
  name: 'Folder workspace',
  folderPath: '/tmp/parent',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 1,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

const PROJECT_GROUP: ProjectGroup = {
  id: 'group-1',
  name: 'Group',
  parentPath: '/tmp/parent',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

describe('host-qualified reveal lookup finds folder workspaces', () => {
  it('returns the folder row index instead of -1', () => {
    // Reveal requests for the current workspace carry executionHostId, which
    // routes here. A walker that only knows item rows returned -1 and the
    // reveal silently never completed (#15362).
    const rows: RenderRow[] = [
      {
        type: 'folder-workspace',
        key: `folder-workspace:${FOLDER_WORKSPACE.id}`,
        folderWorkspace: FOLDER_WORKSPACE,
        projectGroup: PROJECT_GROUP,
        depth: 0,
        groupDepth: 0
      } as RenderRow
    ]

    const index = findPreferredRenderRowIndexForWorktreeIdentity(
      rows,
      { id: folderWorkspaceKey(FOLDER_WORKSPACE.id), hostId: undefined },
      'single-location'
    )

    expect(index).toBe(0)
  })

  it('does not match a different folder workspace', () => {
    const rows: RenderRow[] = [
      {
        type: 'folder-workspace',
        key: 'folder-workspace:other',
        folderWorkspace: { ...FOLDER_WORKSPACE, id: 'other' },
        projectGroup: PROJECT_GROUP,
        depth: 0,
        groupDepth: 0
      } as RenderRow
    ]

    expect(
      findPreferredRenderRowIndexForWorktreeIdentity(
        rows,
        { id: folderWorkspaceKey(FOLDER_WORKSPACE.id), hostId: undefined },
        'single-location'
      )
    ).toBe(-1)
  })
})
