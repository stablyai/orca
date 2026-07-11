// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo, Worktree } from '../../../shared/types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import { useFileDeletion } from '@/components/right-sidebar/useFileDeletion'
import { getFileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer-operation-owner'
import type {
  FileExplorerOperationOwner,
  TreeNode
} from '@/components/right-sidebar/file-explorer-types'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'

const { confirm, toastError } = vi.hoisted(() => ({
  confirm: vi.fn(),
  toastError: vi.fn()
}))
const fsReadFile = vi.fn()
const fsDeletePath = vi.fn()
const runtimeEnvironmentCall = vi.fn()

vi.mock('@/components/confirmation-dialog', () => ({ useConfirmationDialog: () => confirm }))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'Delete' }))
vi.mock('@/components/editor/editor-autosave', () => ({
  requestEditorFileSave: vi.fn().mockResolvedValue(undefined),
  requestEditorSaveQuiesce: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/components/right-sidebar/fileExplorerUndoRedo', () => ({
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

function makeWorktree(hostId: Worktree['hostId']): Worktree {
  return {
    id: LOCAL_WORKTREE_ID,
    repoId: LOCAL_REPO_ID,
    path: '/tmp/project',
    hostId
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
      fs: { readFile: fsReadFile, deletePath: fsDeletePath },
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
  it('keeps a cached runtime node on its listing host after SSH hydration', async () => {
    const workspaceId = folderWorkspaceKey(FOLDER_ID)
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as never,
      folderWorkspaces: [folderWorkspace()],
      projectGroups: [projectGroup()],
      repos: [],
      worktreesByRepo: {}
    })
    const listingOwner = getFileExplorerOperationOwner(workspaceId)
    expect(listingOwner).toEqual({ kind: 'runtime', environmentId: 'focused-env' })
    useAppStore.setState({
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

    await vi.waitFor(() =>
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({ selector: 'focused-env', method: 'files.delete' })
      )
    )
    expect(fsDeletePath).not.toHaveBeenCalled()
  })

  it('fails closed when an exact worktree ID belongs to multiple hosts', async () => {
    useAppStore.setState({
      repos: duplicateHostRepos(),
      worktreesByRepo: {
        [LOCAL_REPO_ID]: [makeWorktree('local'), makeWorktree(`ssh:${SSH_ID}`)]
      }
    })
    const owner = getFileExplorerOperationOwner(LOCAL_WORKTREE_ID)
    expect(owner).toEqual({ kind: 'unresolved' })

    const { result } = renderDelete(LOCAL_WORKTREE_ID)
    await requestDelete(result, localNode, owner)

    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(fsDeletePath).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('keeps an explicit local worktree local when duplicate repo IDs include SSH', async () => {
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as never,
      repos: duplicateHostRepos(),
      worktreesByRepo: { [LOCAL_REPO_ID]: [makeWorktree('local')] }
    })
    const owner = getFileExplorerOperationOwner(LOCAL_WORKTREE_ID)
    expect(owner).toEqual({ kind: 'local' })

    const { result } = renderDelete(LOCAL_WORKTREE_ID)
    await requestDelete(result, localNode, owner)

    await vi.waitFor(() =>
      expect(fsDeletePath).toHaveBeenCalledWith({
        targetPath: localNode.path,
        connectionId: undefined,
        recursive: false
      })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})

function duplicateHostRepos(): Repo[] {
  return [
    makeRepo({ id: LOCAL_REPO_ID, path: '/tmp/project', executionHostId: 'local' }),
    makeRepo({ id: LOCAL_REPO_ID, path: '/home/user/project', connectionId: SSH_ID })
  ]
}
