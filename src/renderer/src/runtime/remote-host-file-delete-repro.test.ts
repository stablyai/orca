// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../shared/types'
import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useFileDeletion } from '@/components/right-sidebar/useFileDeletion'
import { getFileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer-operation-owner'
import type { TreeNode } from '@/components/right-sidebar/file-explorer-types'
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
const REMOTE_REPO_ID = 'repo-ssh'
const REMOTE_WORKTREE_ID = `${REMOTE_REPO_ID}::/home/user/project`
const FOLDER_WORKSPACE_ID = 'folder-workspace-1'
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

const remoteFile: TreeNode = {
  name: 'index.ts',
  path: REMOTE_PATH,
  relativePath: 'src/index.ts',
  isDirectory: false,
  depth: 0,
  operationOwner: { kind: 'ssh', connectionId: SSH_CONNECTION_ID }
}

const localFile: TreeNode = {
  name: 'index.ts',
  path: LOCAL_PATH,
  relativePath: 'src/index.ts',
  isDirectory: false,
  depth: 0,
  operationOwner: { kind: 'local' }
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

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true)
  fsReadFile.mockReset().mockResolvedValue({ content: 'remote', isBinary: false })
  fsDeletePath.mockReset().mockResolvedValue(undefined)
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentCall.mockImplementation((args: { method: string; selector?: string }) => {
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
  toastError.mockReset()
  vi.stubGlobal('window', {
    ...window,
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
  it('keeps an inferred SSH folder workspace off the focused runtime', async () => {
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as never,
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [
        makeRepo({
          id: REMOTE_REPO_ID,
          path: '/home/user/project',
          connectionId: SSH_CONNECTION_ID,
          projectGroupId: 'group-1'
        })
      ],
      sshConnectionStates: new Map([[SSH_CONNECTION_ID, { connectionGeneration: 1 } as never]]),
      worktreesByRepo: {}
    })

    expect(getFileExplorerOperationOwner(folderWorkspaceKey(FOLDER_WORKSPACE_ID))).toEqual({
      kind: 'ssh',
      connectionId: SSH_CONNECTION_ID
    })

    const { result } = renderDelete(folderWorkspaceKey(FOLDER_WORKSPACE_ID))

    await act(async () => {
      result.current.requestDelete(remoteFile)
    })

    await vi.waitFor(() => {
      expect(fsDeletePath).toHaveBeenCalledWith({
        targetPath: REMOTE_PATH,
        connectionId: SSH_CONNECTION_ID,
        expectedExecutionHostId: `ssh:${SSH_CONNECTION_ID}`,
        expectedSshTargetId: SSH_CONNECTION_ID,
        expectedSshConnectionGeneration: 1,
        recursive: false
      })
    })
    expect(toastError).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('fails closed for an ambiguous folder even when a runtime is focused', async () => {
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as never,
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [
        makeRepo({
          id: 'repo-local',
          path: '/home/user/project/local',
          projectGroupId: 'group-1'
        }),
        makeRepo({
          id: 'repo-ssh',
          path: '/home/user/project',
          connectionId: SSH_CONNECTION_ID,
          projectGroupId: 'group-1'
        })
      ],
      worktreesByRepo: {}
    })
    const operationOwner = getFileExplorerOperationOwner(folderWorkspaceKey(FOLDER_WORKSPACE_ID))
    expect(operationOwner).toEqual({ kind: 'unresolved' })

    const { result } = renderDelete(folderWorkspaceKey(FOLDER_WORKSPACE_ID))

    await act(async () => {
      result.current.requestDelete({ ...remoteFile, operationOwner })
    })

    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't determine which host owns this file. Check the workspace connection and try again."
      )
    })
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(fsDeletePath).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('stops while the SSH owner is unresolved instead of deleting locally', async () => {
    useAppStore.setState({
      repos: [],
      worktreesByRepo: {}
    })
    const operationOwner = getFileExplorerOperationOwner(REMOTE_WORKTREE_ID)
    expect(operationOwner).toEqual({ kind: 'unresolved' })

    const { result } = renderDelete(REMOTE_WORKTREE_ID)

    await act(async () => {
      result.current.requestDelete({ ...remoteFile, operationOwner })
    })

    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't determine which host owns this file. Check the workspace connection and try again."
      )
    })
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(fsDeletePath).not.toHaveBeenCalled()
  })

  it('routes a runtime-owned folder workspace with its synthetic worktree path', async () => {
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as never,
      folderWorkspaces: [makeFolderWorkspace({ folderPath: '/tmp/project' })],
      projectGroups: [
        makeProjectGroup({
          parentPath: '/tmp/project',
          executionHostId: 'runtime:env-1'
        })
      ],
      repos: [],
      worktreesByRepo: {}
    })

    const { result } = renderDelete(folderWorkspaceKey(FOLDER_WORKSPACE_ID))

    await act(async () => {
      result.current.requestDelete({
        ...localFile,
        operationOwner: {
          kind: 'runtime',
          environmentId: 'env-1',
          executionHostId: 'runtime:env-1'
        }
      })
    })

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.delete',
        params: {
          worktree: `id:${folderWorkspaceKey(FOLDER_WORKSPACE_ID)}`,
          relativePath: 'src/index.ts',
          recursive: false,
          expectedExecutionHostId: 'local'
        },
        expectedEnvironmentPairingRevision: undefined,
        timeoutMs: 15_000
      })
    })
    expect(fsDeletePath).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})
