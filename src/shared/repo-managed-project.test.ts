import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'
import {
  findMainFolderWorkspace,
  isFolderBackedProjectGroup,
  isRepoManagedProjectGroup,
  isRepoManagedScan,
  resolveFolderWorkspaceCreateIntent
} from './repo-managed-project'

const group: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: '/src/platform',
  parentGroupId: null,
  createdFrom: 'repo-managed',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

function workspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'ws-1',
    projectGroupId: 'group-1',
    name: 'Main',
    folderPath: '/src/platform',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('repo-managed project identity', () => {
  it('recognizes repo-managed groups and scans', () => {
    expect(isRepoManagedProjectGroup(group)).toBe(true)
    expect(isRepoManagedProjectGroup({ ...group, createdFrom: 'folder-scan' })).toBe(false)
    expect(isRepoManagedScan({ selectedPathKind: 'repo_managed' })).toBe(true)
    expect(isRepoManagedScan({ selectedPathKind: 'non_git_folder' })).toBe(false)
  })

  it('treats folder-scan and repo-managed groups as folder-backed', () => {
    expect(isFolderBackedProjectGroup(group)).toBe(true)
    expect(isFolderBackedProjectGroup({ ...group, createdFrom: 'folder-scan' })).toBe(true)
    expect(isFolderBackedProjectGroup({ ...group, createdFrom: 'manual', parentPath: null })).toBe(
      false
    )
  })

  it('finds the main workspace by the group parent path', () => {
    const derived = workspace({ id: 'ws-2', folderPath: '/orca/workspaces/task-a' })
    expect(findMainFolderWorkspace([derived, workspace()], group)?.id).toBe('ws-1')
    expect(findMainFolderWorkspace([derived], group)).toBeUndefined()
  })

  it('resolves create intent for main vs derive vs ordinary folder groups', () => {
    expect(
      resolveFolderWorkspaceCreateIntent({
        group,
        folderWorkspaces: [workspace()],
        deriveRepoManaged: false
      })
    ).toMatchObject({ kind: 'activate-main', workspace: expect.objectContaining({ id: 'ws-1' }) })
    expect(
      resolveFolderWorkspaceCreateIntent({
        group,
        folderWorkspaces: [],
        deriveRepoManaged: false
      })
    ).toEqual({ kind: 'create-main' })
    expect(
      resolveFolderWorkspaceCreateIntent({
        group,
        folderWorkspaces: [workspace()],
        deriveRepoManaged: true
      })
    ).toEqual({ kind: 'derive' })
    expect(
      resolveFolderWorkspaceCreateIntent({
        group: { ...group, createdFrom: 'folder-scan' },
        folderWorkspaces: [workspace()],
        deriveRepoManaged: true
      })
    ).toEqual({ kind: 'create-folder' })
  })
})
