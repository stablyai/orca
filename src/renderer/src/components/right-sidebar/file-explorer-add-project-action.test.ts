import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { TreeNode } from './file-explorer-types'
import {
  buildAddProjectFromFolderModalData,
  canShowAddAsProjectAction
} from './file-explorer-add-project-action'

const folderNode: TreeNode = {
  name: 'child-project',
  path: '/projects/child-project',
  relativePath: 'child-project',
  isDirectory: true,
  depth: 0
}

const fileNode: TreeNode = {
  ...folderNode,
  name: 'README.md',
  path: '/projects/README.md',
  relativePath: 'README.md',
  isDirectory: false
}

const folderRepo: Repo = {
  id: 'folder-repo',
  path: '/projects',
  displayName: 'projects',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'folder'
}

const gitRepo: Repo = {
  ...folderRepo,
  id: 'git-repo',
  kind: 'git'
}

describe('file explorer add project action', () => {
  it('shows only for directories in folder-mode projects', () => {
    expect(canShowAddAsProjectAction(folderNode, folderRepo)).toBe(true)
    expect(canShowAddAsProjectAction(fileNode, folderRepo)).toBe(false)
    expect(canShowAddAsProjectAction(folderNode, gitRepo)).toBe(false)
    expect(canShowAddAsProjectAction(folderNode, null)).toBe(false)
  })

  it('hides the action in an SSH-owned folder, which only a paired server can add from', () => {
    expect(
      canShowAddAsProjectAction(folderNode, {
        ...folderRepo,
        connectionId: 'ssh-1'
      })
    ).toBe(false)
    expect(
      canShowAddAsProjectAction(folderNode, {
        ...folderRepo,
        executionHostId: 'ssh:ssh-1'
      })
    ).toBe(false)
  })

  it('routes a local project subfolder explicitly to local', () => {
    expect(buildAddProjectFromFolderModalData(folderNode, folderRepo)).toEqual({
      folderPath: '/projects/child-project',
      runtimeEnvironmentId: null
    })
  })

  it("routes a runtime project subfolder to the repo's runtime", () => {
    expect(
      buildAddProjectFromFolderModalData(folderNode, {
        ...folderRepo,
        executionHostId: 'runtime:runtime-a'
      })
    ).toEqual({
      folderPath: '/projects/child-project',
      runtimeEnvironmentId: 'runtime-a'
    })
  })
})
