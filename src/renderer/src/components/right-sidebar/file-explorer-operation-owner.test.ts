import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeWorktree, TEST_REPO } from '../../store/slices/worktrees-slice-test-fixtures'
import {
  getFileExplorerOperationOwnerFromState,
  supportsFileExplorerRootNavigation
} from './file-explorer-operation-owner'

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

  it('writes a server-owned folder through that server, and an unstamped one never through focus', () => {
    const state = (folderWorkspaces: FolderWorkspace[], projectGroups: ProjectGroup[]) => ({
      settings: { ...getDefaultSettings('/home'), activeRuntimeEnvironmentId: 'focused-env' },
      runtimeEnvironments: [{ id: 'focused-env' }, { id: 'env-a' }],
      runtimeEnvironmentCatalogHydrated: true,
      repos: [],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      folderWorkspaces,
      projectGroups
    })
    expect(
      getFileExplorerOperationOwnerFromState(
        state(
          [folder('remote-group', 'runtime:env-a', null)],
          [group('remote-group', 'runtime:env-a', null)]
        ),
        'folder:same-folder'
      )
    ).toEqual({ kind: 'runtime', environmentId: 'env-a', executionHostId: 'runtime:env-a' })
    const unstamped = { ...folder('no-group', 'local', null), executionHostId: undefined }
    expect(
      getFileExplorerOperationOwnerFromState(state([unstamped], []), 'folder:same-folder')
    ).toEqual({ kind: 'local' })
  })

  it('refuses a worktree two paired servers publish on the same SSH target (review-5 #2)', () => {
    const worktreeId = `${TEST_REPO.id}::/srv/app`
    const serverCopy = (environmentId: string) =>
      makeWorktree({
        id: worktreeId,
        repoId: TEST_REPO.id,
        hostId: 'ssh:box',
        runtimeOwnerEnvironmentId: environmentId
      })
    const owner = getFileExplorerOperationOwnerFromState(
      {
        settings: null,
        // The desktop also dials `box` itself, so a direct route would pass its generation guard.
        repos: [{ ...TEST_REPO, connectionId: 'box', executionHostId: 'ssh:box' }],
        worktreesByRepo: { [TEST_REPO.id]: [serverCopy('env-a'), serverCopy('env-b')] },
        detectedWorktreesByRepo: {},
        folderWorkspaces: [],
        projectGroups: [],
        restoredRuntimeHostIdByWorkspaceSessionKey: {},
        activeWorktreeId: worktreeId,
        activeWorkspaceExecutionHostId: 'ssh:box'
      },
      worktreeId
    )

    expect(owner).toEqual({ kind: 'unresolved' })
  })

  it("keeps a server folder's nested SSH target as the write's host (review-5 #9)", () => {
    const owner = getFileExplorerOperationOwnerFromState(
      {
        settings: null,
        repos: [],
        worktreesByRepo: {},
        detectedWorktreesByRepo: {},
        restoredRuntimeHostIdByWorkspaceSessionKey: {},
        folderWorkspaces: [folder('remote-group', 'runtime:env-a', 'nested-box')],
        projectGroups: [group('remote-group', 'runtime:env-a', 'nested-box')]
      },
      'folder:same-folder'
    )

    expect(owner).toEqual({
      kind: 'runtime',
      environmentId: 'env-a',
      executionHostId: 'ssh:nested-box'
    })
  })
})

describe('supportsFileExplorerRootNavigation', () => {
  it('supports local and WSL-local filesystem owners but not SSH or remote runtimes', () => {
    expect(supportsFileExplorerRootNavigation({ kind: 'local' })).toBe(true)
    expect(supportsFileExplorerRootNavigation({ kind: 'ssh', connectionId: 'ssh-1' })).toBe(false)
    expect(
      supportsFileExplorerRootNavigation({
        kind: 'runtime',
        environmentId: 'env-1',
        executionHostId: 'runtime:env-1'
      })
    ).toBe(false)
    expect(supportsFileExplorerRootNavigation({ kind: 'unresolved' })).toBe(false)
  })
})
