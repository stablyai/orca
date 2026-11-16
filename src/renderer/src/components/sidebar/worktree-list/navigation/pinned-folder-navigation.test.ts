import { expect, it } from 'vitest'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '../../../../../../shared/folder-workspaces/folder-workspace-host-routing.test-fixture'
import type { FolderWorkspaceRow } from '../../../../../../shared/sidebar-list/row-types'
import { findPreferredRenderRowIndexForWorktreeIdentity } from './render-row-lookup'
import { getRenderedWorkspaceRowsInSidebarOrder } from './worktree-sidebar-row-preference'

const pinned: FolderWorkspaceRow = {
  type: 'folder-workspace',
  key: 'pinned-device',
  sectionKey: 'pinned',
  folderWorkspace: makeFolderWorkspace({ id: 'device', isPinned: true }),
  projectGroup: makeProjectGroup({}),
  depth: 0,
  groupDepth: 0
}
const natural: FolderWorkspaceRow = {
  ...pinned,
  key: 'natural-device',
  sectionKey: 'project-group:personal'
}

it('cycles through the natural occurrence once when a pinned folder is also in its group', () => {
  expect(
    getRenderedWorkspaceRowsInSidebarOrder([pinned, natural], 'duplicate-in-groups').map(
      (row) => row.rowKey
    )
  ).toEqual(['natural-device'])
})

it('reveals the natural occurrence on the requested host when folder ids collide', () => {
  const rows = [
    pinned,
    {
      ...pinned,
      folderWorkspace: { ...pinned.folderWorkspace, executionHostId: 'runtime:mini' as const }
    },
    natural,
    {
      ...natural,
      folderWorkspace: { ...natural.folderWorkspace, executionHostId: 'runtime:mini' as const }
    }
  ]
  expect(
    findPreferredRenderRowIndexForWorktreeIdentity(
      rows,
      { id: 'folder:device', hostId: 'runtime:mini' },
      'duplicate-in-groups'
    )
  ).toBe(3)
})
