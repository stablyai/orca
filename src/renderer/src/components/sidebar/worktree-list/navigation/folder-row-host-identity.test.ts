import { expect, it } from 'vitest'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getRenderRowKey, type RenderRow } from '../listing/render-row'
import { getWorktreeOptionId } from '../rows/option-dom'
import { getActiveDescendantOptionId, getRenderRowOptionId } from './active-descendant-option'
import { getKnownSidebarWorktreeById, sidebarWorkspaceStillExists } from './folder-reveal'
import {
  getRenderRowSidebarKey,
  renderRowContainsWorktree,
  rowKeyMatchesRenderRow
} from './render-row-lookup'

const group: ProjectGroup = {
  id: 'group',
  name: 'Group',
  parentPath: '/folder',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}
const rows: Extract<RenderRow, { type: 'folder-workspace' }>[] = (
  ['local', 'runtime:host'] as const
).map((executionHostId) => ({
  type: 'folder-workspace',
  key: executionHostId,
  folderWorkspace: makeFolderWorkspace({ id: 'same', executionHostId }),
  projectGroup: group,
  depth: 0,
  groupDepth: 0
}))
const workspaceId = 'folder:same'

it.each(['local', 'runtime:host'] as const)(
  'resolves folder reveal requests to the requested host %s',
  (host) => {
    const workspaces = rows.map((row) => row.folderWorkspace)
    const key = `${host}|${workspaceId}`
    expect(getKnownSidebarWorktreeById(key, new Map(), workspaces)?.hostId).toBe(host)
    expect(getKnownSidebarWorktreeById(workspaceId, new Map(), workspaces, [], host)?.hostId).toBe(
      host
    )
    expect(sidebarWorkspaceStillExists(workspaceId, [], workspaces, host)).toBe(true)
    expect(sidebarWorkspaceStillExists(workspaceId, [], workspaces, 'runtime:missing')).toBe(false)
  }
)

it('gives same-ID folders distinct DOM, virtual and sidebar row identities', () => {
  expect(new Set(rows.map(getRenderRowKey)).size).toBe(2)
  expect(new Set(rows.map((row) => getRenderRowOptionId(row))).size).toBe(2)
  for (const row of rows) {
    const key = getWorktreeHostIdentity(folderWorkspaceToWorktree(row.folderWorkspace))
    expect(getRenderRowSidebarKey(row)).toBe(key)
    expect(rowKeyMatchesRenderRow(row, key)).toBe(true)
    expect(
      rowKeyMatchesRenderRow(
        rows.find((other) => other !== row)!,
        key
      )
    ).toBe(false)
  }
})

it.each(['local', 'runtime:host'] as const)(
  'announces the selected folder on %s instead of the first same-ID row',
  (host) => {
    const selected = rows.find((row) => row.folderWorkspace.executionHostId === host)!
    const key = getWorktreeHostIdentity(folderWorkspaceToWorktree(selected.folderWorkspace))
    expect(
      getActiveDescendantOptionId({
        activeWorktreeId: workspaceId,
        activeWorkspaceExecutionHostId: host,
        pinnedDisplayPolicy: 'single-location',
        renderRows: rows,
        virtualItems: [{ index: 0 }, { index: 1 }]
      })
    ).toBe(getWorktreeOptionId(key))
    for (const row of rows) {
      expect(renderRowContainsWorktree(row, workspaceId, host)).toBe(row === selected)
      expect(renderRowContainsWorktree(row, workspaceId)).toBe(true)
    }
  }
)
