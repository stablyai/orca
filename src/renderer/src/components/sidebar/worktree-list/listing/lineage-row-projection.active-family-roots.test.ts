import { describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { buildLineageRowProjection, getActiveFamilyRoots } from './lineage-row-projection'
import type { RenderRow } from './render-row'
import { lineageItemRow as item } from './lineage-row-projection.test-fixture'
import { makeProjectGroup } from '../../workspace-creation/folder/folder-workspace-composer-submit-fixtures'

function collapsedFolder(id: string): RenderRow {
  return {
    type: 'folder-workspace',
    key: `folder:${id}`,
    folderWorkspace: makeFolderWorkspace({ id }),
    projectGroup: makeProjectGroup(),
    depth: 0,
    groupDepth: 0,
    lineageCollapsed: true
  }
}

function activeRoots(rows: RenderRow[], activeId: string): number[] {
  const projection = buildLineageRowProjection(rows, 'none', true)
  return [...getActiveFamilyRoots(rows, projection, activeId, null)]
}

describe('active family roots', () => {
  it('keeps an active parent a family root whether its children are shown or hidden', () => {
    expect(activeRoots([item('parent', 0, false), item('child', 1)], 'parent')).toEqual([0])
    expect(activeRoots([item('parent', 0, true)], 'parent')).toEqual([0])
  })

  it('keeps a collapsed active folder workspace a family root', () => {
    expect(activeRoots([collapsedFolder('platform')], folderWorkspaceKey('platform'))).toEqual([0])
  })

  it('leaves an active workspace without children to its own card surface', () => {
    expect(activeRoots([item('solo', 0), item('other', 0)], 'solo')).toEqual([])
  })
})
