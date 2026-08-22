import { describe, expect, it } from 'vitest'
import type { AppState } from '../../../types'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { findKnownWorktreeById } from './detected-worktree-meta'

const folderWorkspace: FolderWorkspace = {
  id: 'folder-shared',
  projectGroupId: 'group-shared',
  name: 'Runtime folder',
  folderPath: '/runtime/folder',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1,
  connectionId: 'legacy-target'
}

const projectGroup: ProjectGroup = {
  id: folderWorkspace.projectGroupId,
  name: 'Runtime group',
  parentPath: '/runtime',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1,
  executionHostId: 'runtime:env-1'
}

describe('detected folder workspace host identity', () => {
  it('projects legacy folder records through the owning group host', () => {
    const state = {
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      folderWorkspaces: [folderWorkspace],
      projectGroups: [projectGroup],
      settings: getDefaultSettings('/tmp')
    } as Pick<
      AppState,
      | 'worktreesByRepo'
      | 'detectedWorktreesByRepo'
      | 'folderWorkspaces'
      | 'projectGroups'
      | 'settings'
    >

    expect(
      findKnownWorktreeById(state, folderWorkspaceKey(folderWorkspace.id), 'runtime:env-1')
    ).toMatchObject({ hostId: 'runtime:env-1', displayName: folderWorkspace.name })
  })

  it('uses the focused host only when folder and group ownership are absent', () => {
    const legacyFolder = { ...folderWorkspace, connectionId: undefined }
    const legacyGroup = { ...projectGroup, executionHostId: undefined }
    const state = {
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      folderWorkspaces: [legacyFolder],
      projectGroups: [legacyGroup],
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'focused' }
    } as Pick<
      AppState,
      | 'worktreesByRepo'
      | 'detectedWorktreesByRepo'
      | 'folderWorkspaces'
      | 'projectGroups'
      | 'settings'
    >

    expect(
      findKnownWorktreeById(state, folderWorkspaceKey(legacyFolder.id), 'runtime:other')
    ).toBeUndefined()
    expect(
      findKnownWorktreeById(state, folderWorkspaceKey(legacyFolder.id), 'runtime:focused')
    ).toMatchObject({ hostId: 'runtime:focused' })
  })
})
