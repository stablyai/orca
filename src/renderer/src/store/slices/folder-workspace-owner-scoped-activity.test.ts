import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { AppState } from '../types'
import { createTestStore } from './store-test-helpers'

const FOLDER_WORKSPACE_ID = 'shared-folder'
const WORKSPACE_KEY = folderWorkspaceKey(FOLDER_WORKSPACE_ID)
const SSH_HOST_ID = 'ssh:builder' as const

function makeFolderWorkspace(
  executionHostId: ExecutionHostId,
  overrides: Partial<FolderWorkspace> = {}
): FolderWorkspace {
  return {
    id: FOLDER_WORKSPACE_ID,
    projectGroupId: 'group',
    name: executionHostId,
    folderPath: executionHostId === 'local' ? '/local/folder' : '/remote/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    executionHostId,
    ...overrides
  }
}

function createOwnerScopedStore(overrides: Partial<FolderWorkspace> = {}) {
  const store = createTestStore()
  const updateFolderWorkspace = vi.fn().mockResolvedValue(true)
  store.setState({
    folderWorkspaces: [
      makeFolderWorkspace('local', overrides),
      makeFolderWorkspace(SSH_HOST_ID, overrides)
    ],
    activeWorktreeId: WORKSPACE_KEY,
    activeWorkspaceKey: WORKSPACE_KEY,
    activeWorkspaceExecutionHostId: SSH_HOST_ID,
    updateFolderWorkspace
  } as Partial<AppState>)
  return { store, updateFolderWorkspace }
}

function folderForHost(state: AppState, hostId: ExecutionHostId): FolderWorkspace {
  return state.folderWorkspaces.find((workspace) => workspace.executionHostId === hostId)!
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('folder workspace owner-scoped activity', () => {
  it('marks only the active physical owner unread', () => {
    const { store, updateFolderWorkspace } = createOwnerScopedStore()

    store.getState().markWorktreeUnread(WORKSPACE_KEY)

    expect(folderForHost(store.getState(), 'local').isUnread).toBe(false)
    expect(folderForHost(store.getState(), SSH_HOST_ID)).toMatchObject({
      isUnread: true,
      lastActivityAt: 1_000
    })
    expect(updateFolderWorkspace).toHaveBeenCalledWith(
      FOLDER_WORKSPACE_ID,
      { isUnread: true, lastActivityAt: 1_000 },
      { executionHostId: SSH_HOST_ID }
    )
  })

  it('clears unread only for the active physical owner', () => {
    const { store, updateFolderWorkspace } = createOwnerScopedStore({ isUnread: true })

    store.getState().clearWorktreeUnread(WORKSPACE_KEY)

    expect(folderForHost(store.getState(), 'local').isUnread).toBe(true)
    expect(folderForHost(store.getState(), SSH_HOST_ID).isUnread).toBe(false)
    expect(updateFolderWorkspace).toHaveBeenCalledWith(
      FOLDER_WORKSPACE_ID,
      { isUnread: false },
      { executionHostId: SSH_HOST_ID }
    )
  })

  it('bumps and persists activity only for the active physical owner', () => {
    const { store, updateFolderWorkspace } = createOwnerScopedStore()

    store.getState().bumpWorktreeActivity(WORKSPACE_KEY)

    expect(folderForHost(store.getState(), 'local').lastActivityAt).toBe(1)
    expect(folderForHost(store.getState(), SSH_HOST_ID).lastActivityAt).toBe(1_000)
    expect(updateFolderWorkspace).toHaveBeenCalledWith(
      FOLDER_WORKSPACE_ID,
      { lastActivityAt: 1_000 },
      { executionHostId: SSH_HOST_ID }
    )
  })

  it('routes metadata updates to the active physical owner', async () => {
    const { store, updateFolderWorkspace } = createOwnerScopedStore()

    await expect(
      store.getState().updateWorktreeMeta(WORKSPACE_KEY, { isPinned: true })
    ).resolves.toEqual({ ok: true })
    expect(updateFolderWorkspace).toHaveBeenCalledWith(
      FOLDER_WORKSPACE_ID,
      { isPinned: true },
      { executionHostId: SSH_HOST_ID }
    )
  })

  it('generic activation clears only the explicitly selected owner', () => {
    const { store, updateFolderWorkspace } = createOwnerScopedStore({ isUnread: true })
    store.setState({
      activeWorktreeId: null,
      activeWorkspaceKey: null,
      activeWorkspaceExecutionHostId: null,
      refreshGitHubForWorktreeIfStale: vi.fn()
    })

    expect(store.getState().setActiveWorktree(WORKSPACE_KEY, SSH_HOST_ID)).toBe(true)

    expect(store.getState().activeWorkspaceExecutionHostId).toBe(SSH_HOST_ID)
    expect(folderForHost(store.getState(), 'local').isUnread).toBe(true)
    expect(folderForHost(store.getState(), SSH_HOST_ID).isUnread).toBe(false)
    expect(updateFolderWorkspace).toHaveBeenCalledWith(
      FOLDER_WORKSPACE_ID,
      { isUnread: false },
      { executionHostId: SSH_HOST_ID }
    )
  })
})
