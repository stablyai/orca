import { describe, expect, it } from 'vitest'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '../../folder-workspaces/folder-workspace-host-routing.test-fixture'
import { getRenderableFolderWorkspaces } from './folder-workspace-lanes'

const manualGroup = makeProjectGroup({ id: 'group-manual', name: 'Manual', parentPath: null })
const folderWorkspace = makeFolderWorkspace({ projectGroupId: manualGroup.id })

describe('getRenderableFolderWorkspaces', () => {
  it('renders a folder workspace whose owning group has no base folder', () => {
    expect(getRenderableFolderWorkspaces([folderWorkspace], [manualGroup])).toEqual([
      { folderWorkspace, projectGroup: manualGroup }
    ])
  })

  it('hides a folder workspace whose owning group is not visible', () => {
    expect(getRenderableFolderWorkspaces([folderWorkspace], [])).toEqual([])
  })
})
