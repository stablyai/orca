import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { findFolderWorkspaceForMeta } from './use-worktree-meta-workspace'

function folder(
  executionHostId: FolderWorkspace['executionHostId'],
  name: string
): FolderWorkspace {
  return {
    id: 'folder-shared',
    projectGroupId: 'group-shared',
    name,
    folderPath: `/${name}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    executionHostId
  }
}

function group(executionHostId: ProjectGroup['executionHostId']): ProjectGroup {
  return {
    id: 'group-shared',
    name: 'Group',
    parentPath: '/group',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    executionHostId
  }
}

describe('folder workspace metadata identity', () => {
  it('selects the requested host when folder ids collide', () => {
    const local = folder('local', 'Local')
    const runtime = folder('runtime:env-1', 'Runtime')

    expect(
      findFolderWorkspaceForMeta(
        [local, runtime],
        [group('local'), group('runtime:env-1')],
        runtime.id,
        'runtime:env-1'
      )
    ).toBe(runtime)
  })

  it('uses group ownership for a legacy folder record', () => {
    const runtime = { ...folder(undefined, 'Runtime'), connectionId: 'legacy-target' }

    expect(
      findFolderWorkspaceForMeta([runtime], [group('runtime:env-1')], runtime.id, 'runtime:env-1')
    ).toBe(runtime)
  })
})
