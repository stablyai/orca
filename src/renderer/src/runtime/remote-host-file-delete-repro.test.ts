// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo, Worktree } from '../../../shared/types'
import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useFileDeletion } from '@/components/right-sidebar/useFileDeletion'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'

const { confirm, toastError } = vi.hoisted(() => ({
  confirm: vi.fn(),
  toastError: vi.fn()
}))
const fsReadFile = vi.fn()
const fsDeletePath = vi.fn()
const runtimeEnvironmentCall = vi.fn()

vi.mock('@/components/confirmation-dialog', () => ({
  useConfirmationDialog: () => confirm
}))
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
const SSH_CONNECTION_ID = 'ssh-target-1'
const REMOTE_PATH = '/home/user/project/src/index.ts'
const FOLDER_WORKSPACE_ID = 'folder-workspace-1'
const LOCAL_REPO_ID = 'repo-local'
const LOCAL_WORKTREE_ID = `${LOCAL_REPO_ID}::/tmp/project`
const LOCAL_PATH = '/tmp/project/src/index.ts'

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: FOLDER_WORKSPACE_ID,
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
    updatedAt: 1,
    ...overrides
  }
}

function makeProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
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
    updatedAt: 1,
    ...overrides
  }
}

function makeRepo(overrides: Partial<Repo> & { id: string; path: string }): Repo {
  return {
    displayName: overrides.id,
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

function makeWorktree(id: string, repoId: string, path: string): Worktree {
  return {
    id,
    repoId,
    path
  } as Worktree
}

const remoteFile = {
  name: 'index.ts',
  path: REMOTE_PATH,
  relativePath: 'src/index.ts',
  isDirectory: false,
  depth: 0
}

const localFile = {
  name: 'index.ts',
  path: LOCAL_PATH,
  relativePath: 'src/index.ts',
  isDirectory: false,
  depth: 0
}

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true)
  fsReadFile.mockReset().mockResolvedValue({ content: 'remote', isBinary: false })
  fsDeletePath.mockReset().mockResolvedValue(undefined)
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentCall.mockImplementation((args: { method: string }) => {
    return (
      createCompatibleRuntimeStatusResponseIfNeeded(args, 'env-1') ?? {
        id: 'rpc-1',
        ok: true,
        result: null,
        _meta: { runtimeId: 'env-1' }
      }
    )
  })
  toastError.mockReset()
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

describe('issue #8135: deleting a remote SSH folder file', () => {
  it('keeps the resolved file owner on the filesystem route', async () => {
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [
        makeRepo({ id: 'repo-local', path: '/home/user/project/local' }),
        makeRepo({
          id: 'repo-ssh',
          path: '/home/user/project',
          connectionId: SSH_CONNECTION_ID,
          projectGroupId: 'group-1'
        })
      ],
      worktreesByRepo: {}
    })

    const { result } = renderHook(() =>
      useFileDeletion({
        activeWorktreeId: folderWorkspaceKey(FOLDER_WORKSPACE_ID),
        openFiles: [],
        closeFile: vi.fn(),
        refreshDir: vi.fn().mockResolvedValue(undefined),
        setSelectedPaths: vi.fn(),
        isWindows: false
      })
    )

    await act(async () => {
      result.current.requestDelete(remoteFile)
    })

    await vi.waitFor(() => {
      expect(fsDeletePath).toHaveBeenCalledWith({
        targetPath: REMOTE_PATH,
        connectionId: SSH_CONNECTION_ID,
        recursive: false
      })
    })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('stops while the SSH owner is unresolved instead of deleting locally', async () => {
    useAppStore.setState({
      repos: [],
      worktreesByRepo: {}
    })

    const { result } = renderHook(() =>
      useFileDeletion({
        activeWorktreeId: `repo-ssh::/home/user/project`,
        openFiles: [],
        closeFile: vi.fn(),
        refreshDir: vi.fn().mockResolvedValue(undefined),
        setSelectedPaths: vi.fn(),
        isWindows: false
      })
    )

    await act(async () => {
      result.current.requestDelete(remoteFile)
    })

    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't determine which host owns this file, so Orca won't delete it from the wrong machine."
      )
    })
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(fsDeletePath).not.toHaveBeenCalled()
  })

  it('keeps runtime-environment deletes on files.delete even when the repo owner is unresolved', async () => {
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [],
      worktreesByRepo: {
        [LOCAL_REPO_ID]: [makeWorktree(LOCAL_WORKTREE_ID, LOCAL_REPO_ID, '/tmp/project')]
      }
    })

    const { result } = renderHook(() =>
      useFileDeletion({
        activeWorktreeId: LOCAL_WORKTREE_ID,
        openFiles: [],
        closeFile: vi.fn(),
        refreshDir: vi.fn().mockResolvedValue(undefined),
        setSelectedPaths: vi.fn(),
        isWindows: false
      })
    )

    await act(async () => {
      result.current.requestDelete(localFile)
    })

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.delete',
        params: {
          worktree: `id:${LOCAL_WORKTREE_ID}`,
          relativePath: 'src/index.ts',
          recursive: false
        },
        timeoutMs: 15_000
      })
    })
    expect(fsDeletePath).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('preserves ordinary local deletes when no remote owner exists', async () => {
    useAppStore.setState({
      repos: [makeRepo({ id: LOCAL_REPO_ID, path: '/tmp/project' })],
      worktreesByRepo: {
        [LOCAL_REPO_ID]: [makeWorktree(LOCAL_WORKTREE_ID, LOCAL_REPO_ID, '/tmp/project')]
      }
    })

    const { result } = renderHook(() =>
      useFileDeletion({
        activeWorktreeId: LOCAL_WORKTREE_ID,
        openFiles: [],
        closeFile: vi.fn(),
        refreshDir: vi.fn().mockResolvedValue(undefined),
        setSelectedPaths: vi.fn(),
        isWindows: false
      })
    )

    await act(async () => {
      result.current.requestDelete(localFile)
    })

    await vi.waitFor(() => {
      expect(fsDeletePath).toHaveBeenCalledWith({
        targetPath: LOCAL_PATH,
        connectionId: undefined,
        recursive: false
      })
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })
})
