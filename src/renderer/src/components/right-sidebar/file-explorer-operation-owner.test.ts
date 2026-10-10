import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { getFileExplorerOperationOwnerFromState } from './file-explorer-operation-owner'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

function folder(
  projectGroupId: string,
  executionHostId: ExecutionHostId,
  connectionId: string | null
): FolderWorkspace {
  return {
    id: 'same-folder',
    projectGroupId,
    name: 'Notes',
    folderPath: '/notes',
    executionHostId,
    connectionId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function group(
  id: string,
  executionHostId: ExecutionHostId,
  connectionId: string | null
): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: '/',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    connectionId,
    executionHostId,
    createdAt: 0,
    updatedAt: 0
  }
}

describe('getFileExplorerOperationOwnerFromState', () => {
  it("never hands a selected local folder the same-id server folder's nested SSH target", () => {
    const owner = getFileExplorerOperationOwnerFromState(
      {
        settings: null,
        repos: [],
        worktreesByRepo: {},
        detectedWorktreesByRepo: {},
        restoredRuntimeHostIdByWorkspaceSessionKey: {},
        activeWorktreeId: 'folder:same-folder',
        activeWorkspaceExecutionHostId: 'local',
        // The server's copy comes first, as a catalog merge can order it.
        folderWorkspaces: [
          folder('remote-group', 'runtime:env-a', 'nested-box'),
          folder('local-group', 'local', null)
        ],
        projectGroups: [
          group('remote-group', 'runtime:env-a', 'nested-box'),
          group('local-group', 'local', null)
        ]
      },
      'folder:same-folder'
    )

    expect(owner).toEqual({ kind: 'local' })
  })
})
