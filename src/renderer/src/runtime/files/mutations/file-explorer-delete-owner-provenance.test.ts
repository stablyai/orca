// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../shared/project-group-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import { useAppStore } from '@/store/index'
import { useFileDeletion } from '@/components/right-sidebar/file-explorer/mutations/useFileDeletion'
import { getFileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer/navigation/file-explorer-operation-owner'
import type {
  FileExplorerOperationOwner,
  TreeNode
} from '@/components/right-sidebar/file-explorer/tree/file-explorer-types'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { renameFileOnDisk } from '@/lib/editor/file-operations/rename-file'

const { confirm, toastError } = vi.hoisted(() => ({
  confirm: vi.fn(),
  toastError: vi.fn()
}))
const fsReadFile = vi.fn()
const fsDeletePath = vi.fn()
const fsRenamePath = vi.fn()
const runtimeEnvironmentCall = vi.fn()

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirm
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'Delete' }))
vi.mock('@/components/editor/autosave/editor-autosave', () => ({
  requestEditorFileSave: vi.fn().mockResolvedValue(undefined),
  requestEditorSaveQuiesce: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/components/right-sidebar/file-explorer/mutations/fileExplorerUndoRedo', () => ({
  commitFileExplorerOp: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

const initialState = useAppStore.getInitialState()
const SSH_ID = 'ssh-target-1'
const FOLDER_ID = 'folder-workspace-1'
const LOCAL_REPO_ID = 'repo-shared'
const LOCAL_WORKTREE_ID = `${LOCAL_REPO_ID}::/tmp/project`
const localNode: TreeNode = {
  name: 'index.ts',
  path: '/tmp/project/src/index.ts',
  relativePath: 'src/index.ts',
  isDirectory: false,
  depth: 0,
  operationOwner: { kind: 'local' }
}

function makeRepo(overrides: Partial<Repo> & { id: string; path: string }): Repo {
  return { displayName: overrides.id, badgeColor: '#000', addedAt: 0, ...overrides }
}

function makeWorktree(hostId: Worktree['hostId'], runtimeOwnerEnvironmentId?: string): Worktree {
  return {
    id: LOCAL_WORKTREE_ID,
    repoId: LOCAL_REPO_ID,
    path: '/tmp/project',
    hostId,
    runtimeOwnerEnvironmentId
  } as Worktree
}

function folderWorkspace(): FolderWorkspace {
  return {
    id: FOLDER_ID,
    projectGroupId: 'group-1',
    name: 'Remote workspace',
    folderPath: '/home/user/project',
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

function projectGroup(): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Remote workspace',
    parentPath: '/home/user/project',
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function renderDelete(activeWorktreeId: string) {
  return renderHook(() =>
    useFileDeletion({
      activeWorktreeId,
      openFiles: [],
      closeFile: vi.fn(),
      refreshDir: vi.fn().mockResolvedValue(undefined),
      setSelectedPaths: vi.fn(),
      isWindows: false
    })
  )
}

async function requestDelete(
  result: ReturnType<typeof renderDelete>['result'],
  node: TreeNode,
  operationOwner: FileExplorerOperationOwner
): Promise<void> {
  await act(async () => {
    result.current.requestDelete({ ...node, operationOwner })
  })
}

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true)
  toastError.mockReset()
  fsReadFile.mockReset().mockResolvedValue({ content: 'content', isBinary: false })
  fsDeletePath.mockReset().mockResolvedValue(undefined)
  fsRenamePath.mockReset().mockResolvedValue(undefined)
  runtimeEnvironmentCall
    .mockReset()
    .mockImplementation((args: { selector?: string; method: string }) => {
      const runtimeId = args.selector ?? 'env-1'
      return (
        createCompatibleRuntimeStatusResponseIfNeeded(args, runtimeId) ?? {
          id: 'rpc-1',
          ok: true,
          result: null,
          _meta: { runtimeId }
        }
      )
    })
  vi.stubGlobal('window', {
    api: {
      fs: { readFile: fsReadFile, deletePath: fsDeletePath, renamePath: fsRenamePath },
      runtime: { call: vi.fn() },
      runtimeEnvironments: { call: runtimeEnvironmentCall, subscribe: vi.fn() }
    }
  })
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.unstubAllGlobals()
})

describe('file explorer deletion owner provenance', () => {
  it('fails a cached rename closed when ownership changed after listing', async () => {
    useAppStore.setState({
      repos: [
        makeRepo({
          id: LOCAL_REPO_ID,
          path: '/tmp/project',
          executionHostId: 'runtime:hub-a'
        })
      ],
      worktreesByRepo: {
        [LOCAL_REPO_ID]: [makeWorktree('ssh:hub-private-target', 'hub-a')]
      }
    })
    const listingOwner = getFileExplorerOperationOwner(LOCAL_WORKTREE_ID)
    expect(listingOwner).toEqual({
      kind: 'runtime',
      environmentId: 'hub-a',
      executionHostId: 'ssh:hub-private-target'
    })
    useAppStore.setState({
      worktreesByRepo: {
        [LOCAL_REPO_ID]: [makeWorktree('ssh:hub-private-target', 'hub-b')]
      }
    })

    await expect(
      renameFileOnDisk({
        oldPath: '/tmp/project/src/old.ts',
        newName: 'new.ts',
        worktreeId: LOCAL_WORKTREE_ID,
        worktreePath: '/tmp/project',
        operationOwner: listingOwner
      })
    ).rejects.toThrow("Couldn't determine which host owns this workspace")
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(fsRenamePath).not.toHaveBeenCalled()
  })

  it('fails a cached runtime node closed after SSH ownership hydration changes', async () => {
    const workspaceId = folderWorkspaceKey(FOLDER_ID)
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as never,
      folderWorkspaces: [folderWorkspace()],
      projectGroups: [{ ...projectGroup(), executionHostId: 'runtime:focused-env' }],
      runtimeEnvironments: [{ id: 'focused-env' } as never],
      repos: [],
      worktreesByRepo: {}
    })
    const listingOwner = getFileExplorerOperationOwner(workspaceId)
    expect(listingOwner).toEqual({
      kind: 'runtime',
      environmentId: 'focused-env',
      executionHostId: 'runtime:focused-env'
    })
    useAppStore.setState({
      projectGroups: [
        { ...projectGroup(), connectionId: SSH_ID, executionHostId: `ssh:${SSH_ID}` }
      ],
      repos: [
        makeRepo({
          id: 'repo-ssh',
          path: '/home/user/project',
          connectionId: SSH_ID,
          projectGroupId: 'group-1'
        })
      ]
    })
    expect(getFileExplorerOperationOwner(workspaceId)).toEqual({
      kind: 'ssh',
      connectionId: SSH_ID
    })

    const { result } = renderDelete(workspaceId)
    await requestDelete(
      result,
      { ...localNode, path: '/home/user/project/src/index.ts' },
      listingOwner
    )

    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'focused-env', method: 'files.delete' })
    )
    expect(fsDeletePath).not.toHaveBeenCalled()
  })
})
