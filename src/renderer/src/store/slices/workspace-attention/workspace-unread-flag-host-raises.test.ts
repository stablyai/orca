import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../types'
import type * as WorktreeMetaPersistModule from '../worktrees/metadata/worktree-meta-persist'
import { persistWorktreeMeta } from '../worktrees/metadata/worktree-meta-persist'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import { WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY } from '../../../../../shared/workspace-unread-raise-capability'
import { createTestStore, makeWorktree, TEST_REPO } from '../store-test-helpers'
import { makeFolderWorkspace } from '../worktrees-slice-test-fixtures'
import { clearWorkspaceUnreadFlag, markWorkspaceUnreadFlag } from './workspace-unread-flag'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'

// With the switch on, the window raises the flag exactly where the owning host does not.

const hostCapabilities = vi.hoisted(() => new Map<string, Promise<readonly string[]>>())
const cachedStatus = vi.hoisted(() => new Map<string, readonly string[]>())

vi.mock('../../../../../shared/sidebar-inputs-switch', () => ({
  ORCA_SIDEBAR_INPUTS_IS_MAIN: true
}))
vi.mock('../worktrees/metadata/worktree-meta-persist', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeMetaPersistModule>()
  return { ...actual, persistWorktreeMeta: vi.fn(async () => undefined) }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({
  // Null before the environment's first status probe, as the real cache.
  readCachedRuntimeEnvironmentCapability: (environmentId: string, capability: string) =>
    cachedStatus.get(environmentId)?.includes(capability) ?? null,
  // Settles with the environment's status probe; rejects when it cannot be read.
  runtimeEnvironmentSupportsCapability: vi.fn(async (environmentId: string, capability: string) => {
    const capabilities = await hostCapabilities.get(environmentId)
    if (!capabilities) {
      throw new Error('runtime unreachable')
    }
    return capabilities.includes(capability)
  })
}))
vi.mock('../worktrees/listing/worktree-owner-target', () => ({
  // `/server-<env>/` paths and `runtime:<env>` hosts belong to that paired server; the rest to this app.
  tryRuntimeTargetForWorktreeOwner: (_state: unknown, workspaceId: string, hostId?: string) => {
    const environmentId =
      hostId?.replace(/^runtime:/, '') ?? /\/server-([^/]+)\//.exec(workspaceId)?.[1]
    return environmentId && environmentId !== 'local'
      ? { kind: 'environment', environmentId }
      : { kind: 'local' }
  }
}))

const LOCAL_WT = 'repo1::/path/local/a'
const NEW_SERVER_WT = 'repo1::/path/server-new/a'
const OLD_SERVER_WT = 'repo1::/path/server-old/a'
const SLOW_SERVER_WT = 'repo1::/path/server-slow/a'
const UNREACHABLE_SERVER_WT = 'repo1::/path/server-unreachable/a'
const FOLDER_ID = 'folder-1'

function createStore() {
  const store = createTestStore()
  const updateFolderWorkspace = vi.fn<AppState['updateFolderWorkspace']>(async () => true)
  store.setState({
    repos: [{ ...TEST_REPO, executionHostId: 'local' }],
    worktreesByRepo: {
      repo1: [LOCAL_WT, NEW_SERVER_WT, OLD_SERVER_WT, SLOW_SERVER_WT, UNREACHABLE_SERVER_WT].map(
        (id) => makeWorktree({ id, repoId: 'repo1', path: id.replace('repo1::', '') })
      )
    },
    folderWorkspaces: [
      makeFolderWorkspace({ id: FOLDER_ID, executionHostId: 'runtime:old' }),
      makeFolderWorkspace({ id: FOLDER_ID, executionHostId: 'runtime:new' })
    ],
    updateFolderWorkspace
  })
  const mark = async (id: string): Promise<void> => {
    markWorkspaceUnreadFlag(store.setState, store.getState, id)
    // The decision settles after the host's status answers.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const isUnread = (id: string): boolean =>
    Object.values(store.getState().worktreesByRepo)
      .flat()
      .some((worktree) => worktree.id === id && worktree.isUnread)
  return { store, mark, isUnread, updateFolderWorkspace }
}

beforeEach(() => {
  vi.clearAllMocks()
  hostCapabilities.clear()
  cachedStatus.clear()
  hostCapabilities.set('new', Promise.resolve([WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY]))
  hostCapabilities.set('old', Promise.resolve(['runtime.status.compat.v1']))
})

describe('the window raises the unread flag only where its host does not', () => {
  it('leaves it to this app’s own main, which covers its local and SSH workspaces', async () => {
    const { mark, isUnread } = createStore()
    await mark(LOCAL_WT)
    expect(isUnread(LOCAL_WT)).toBe(false)
    expect(persistWorktreeMeta).not.toHaveBeenCalled()
  })

  it('leaves it to a paired server that raises it', async () => {
    const { mark, isUnread } = createStore()
    await mark(NEW_SERVER_WT)
    expect(isUnread(NEW_SERVER_WT)).toBe(false)
    expect(persistWorktreeMeta).not.toHaveBeenCalled()
  })

  it('raises it on an older paired server, writing to that server', async () => {
    const { mark, isUnread } = createStore()
    await mark(OLD_SERVER_WT)
    expect(isUnread(OLD_SERVER_WT)).toBe(true)
    expect(persistWorktreeMeta).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'old' },
      OLD_SERVER_WT,
      expect.objectContaining({ isUnread: true })
    )
  })

  it('answers from the cached status without probing again', async () => {
    const { mark, isUnread } = createStore()
    cachedStatus.set('slow', [WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY])
    await mark(SLOW_SERVER_WT)
    expect(isUnread(SLOW_SERVER_WT)).toBe(false)
    cachedStatus.set('slow', [])
    await mark(SLOW_SERVER_WT)
    expect(isUnread(SLOW_SERVER_WT)).toBe(true)
    expect(runtimeEnvironmentSupportsCapability).not.toHaveBeenCalled()
  })

  it('waits for a server’s first status, and raises it when the status cannot be read', async () => {
    const { mark, isUnread } = createStore()
    let answer: (capabilities: readonly string[]) => void = () => {}
    hostCapabilities.set('slow', new Promise((resolve) => (answer = resolve)))
    await mark(SLOW_SERVER_WT)
    expect(isUnread(SLOW_SERVER_WT)).toBe(false)
    answer([])
    await vi.waitFor(() => expect(isUnread(SLOW_SERVER_WT)).toBe(true))

    await mark(UNREACHABLE_SERVER_WT)
    expect(isUnread(UNREACHABLE_SERVER_WT)).toBe(true)
  })

  it('drops a raise still waiting on a server’s first status once the user marks it read', async () => {
    const { store, mark, isUnread } = createStore()
    let answer: (capabilities: readonly string[]) => void = () => {}
    hostCapabilities.set('slow', new Promise((resolve) => (answer = resolve)))
    await mark(SLOW_SERVER_WT)
    store.getState().setWorkspaceUnreadByUser(SLOW_SERVER_WT, false, 'runtime:slow')
    answer([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(isUnread(SLOW_SERVER_WT)).toBe(false)
  })

  it('decides a folder workspace by the host of the row it raises', async () => {
    const { store, mark, updateFolderWorkspace } = createStore()
    const folder = folderWorkspaceKey(FOLDER_ID)
    store.setState({ activeWorktreeId: folder, activeWorkspaceExecutionHostId: 'runtime:new' })
    await mark(folder)
    expect(updateFolderWorkspace).not.toHaveBeenCalled()

    store.setState({ activeWorkspaceExecutionHostId: 'runtime:old' })
    await mark(folder)
    expect(updateFolderWorkspace).toHaveBeenCalledWith(
      FOLDER_ID,
      expect.objectContaining({ isUnread: true }),
      { executionHostId: 'runtime:old' }
    )
  })

  it('raises the folder row it decided for, even if the screen moves to the other row meanwhile', async () => {
    const { store, mark, updateFolderWorkspace } = createStore()
    const folder = folderWorkspaceKey(FOLDER_ID)
    let answer: (capabilities: readonly string[]) => void = () => {}
    hostCapabilities.set('old', new Promise((resolve) => (answer = resolve)))
    store.setState({ activeWorktreeId: folder, activeWorkspaceExecutionHostId: 'runtime:old' })
    await mark(folder)
    store.setState({ activeWorkspaceExecutionHostId: 'runtime:new' })
    answer([])
    await vi.waitFor(() =>
      expect(updateFolderWorkspace).toHaveBeenCalledWith(
        FOLDER_ID,
        expect.objectContaining({ isUnread: true }),
        { executionHostId: 'runtime:old' }
      )
    )
    expect(updateFolderWorkspace).toHaveBeenCalledTimes(1)
  })

  it('clears a flag on every owner, whichever side raised it', () => {
    const { store, isUnread } = createStore()
    for (const id of [LOCAL_WT, NEW_SERVER_WT, OLD_SERVER_WT]) {
      store.setState((s) => ({
        worktreesByRepo: {
          repo1: s.worktreesByRepo.repo1.map((worktree) =>
            worktree.id === id ? { ...worktree, isUnread: true } : worktree
          )
        }
      }))
      clearWorkspaceUnreadFlag(store.setState, store.getState, id)
      expect(isUnread(id)).toBe(false)
      expect(persistWorktreeMeta).toHaveBeenLastCalledWith(expect.anything(), id, {
        isUnread: false
      })
    }
  })
})
