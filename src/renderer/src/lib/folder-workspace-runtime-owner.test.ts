import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { findFolderWorkspaceOwner } from './folder-workspace-runtime-owner'

const folder = {
  id: 'folder-1',
  projectGroupId: 'group-1'
} as FolderWorkspace

const runtimeGroup = {
  id: 'group-1',
  executionHostId: 'runtime:owner'
} as ProjectGroup

describe('folder workspace runtime owner', () => {
  it('resolves a legacy folder through its runtime-owned project group', () => {
    const state = {
      folderWorkspaces: [folder],
      projectGroups: [runtimeGroup],
      settings: { activeRuntimeEnvironmentId: null }
    }

    expect(findFolderWorkspaceOwner(state, folder.id, 'runtime:owner')).toBe(folder)
    expect(findFolderWorkspaceOwner(state, folder.id, 'local')).toBeNull()
  })

  it('keeps an explicit folder owner authoritative over its group', () => {
    const localFolder = { ...folder, executionHostId: 'local' as const }
    const state = {
      folderWorkspaces: [localFolder],
      projectGroups: [runtimeGroup],
      settings: { activeRuntimeEnvironmentId: 'owner' }
    }

    expect(findFolderWorkspaceOwner(state, folder.id, 'local')).toBe(localFolder)
    expect(findFolderWorkspaceOwner(state, folder.id, 'runtime:owner')).toBeNull()
  })
})
