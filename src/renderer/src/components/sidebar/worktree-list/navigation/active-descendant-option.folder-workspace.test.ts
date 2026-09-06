import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { PINNED_GROUP_KEY, getProjectGroupHeaderKey } from '../grouping/group-keys'
import { buildFolderWorkspaceRow } from '../grouping/row-builders'
import type { RenderRow } from '../listing/render-row'
import { getWorktreeOptionId } from '../rows/option-dom'
import { getActiveDescendantOptionId, getRenderRowOptionId } from './active-descendant-option'

const FOLDER_WORKSPACE: FolderWorkspace = {
  id: 'fw-1',
  projectGroupId: 'group-1',
  name: 'Folder workspace',
  folderPath: '/tmp/parent',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: true,
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

const GROUP_SECTION_KEY = getProjectGroupHeaderKey(PROJECT_GROUP.id)
const WORKSPACE_ID = folderWorkspaceKey(FOLDER_WORKSPACE.id)

function folderRow(sectionKey: string): RenderRow {
  return buildFolderWorkspaceRow(
    { folderWorkspace: FOLDER_WORKSPACE, projectGroup: PROJECT_GROUP },
    sectionKey,
    0
  )
}

describe('folder workspace active-descendant ids', () => {
  it('names the row that rendered, not the workspace', () => {
    // Why this matters: folder-row.tsx puts row.key in the DOM id. An option id
    // derived from the workspace id instead would dangle on the pinned copy,
    // and aria-activedescendant would point at no element at all.
    const pinnedRow = folderRow(PINNED_GROUP_KEY)
    expect(getRenderRowOptionId(pinnedRow)).toBe(
      getWorktreeOptionId(`${PINNED_GROUP_KEY}:folder-workspace:fw-1`)
    )
    expect(getRenderRowOptionId(folderRow(GROUP_SECTION_KEY))).not.toBe(
      getRenderRowOptionId(pinnedRow)
    )
  })

  it('points at the natural copy when the pinned duplicate is also mounted', () => {
    const renderRows = [folderRow(PINNED_GROUP_KEY), folderRow(GROUP_SECTION_KEY)]

    expect(
      getActiveDescendantOptionId({
        activeWorktreeId: WORKSPACE_ID,
        pinnedDisplayPolicy: 'duplicate-in-groups',
        renderRows,
        virtualItems: [{ index: 0 }, { index: 1 }]
      })
    ).toBe(getRenderRowOptionId(renderRows[1]))
  })

  it('falls back to the pinned copy when it is the only one mounted', () => {
    const renderRows = [folderRow(PINNED_GROUP_KEY)]

    expect(
      getActiveDescendantOptionId({
        activeWorktreeId: WORKSPACE_ID,
        pinnedDisplayPolicy: 'duplicate-in-groups',
        renderRows,
        virtualItems: [{ index: 0 }]
      })
    ).toBe(getRenderRowOptionId(renderRows[0]))
  })
})
