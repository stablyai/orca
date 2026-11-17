// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'

import { useAppStore } from '@/store/index'

import { getFileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer/navigation/file-explorer-operation-owner'

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
vi.mock('@/lib/keyboard/useShortcutLabel', () => ({ useShortcutLabel: () => 'Delete' }))
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

const LOCAL_REPO_ID = 'repo-shared'
const LOCAL_WORKTREE_ID = `${LOCAL_REPO_ID}::/tmp/project`

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
})
