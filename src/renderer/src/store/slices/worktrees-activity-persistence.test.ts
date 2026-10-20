import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeFolderWorkspace, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

// The window raises the flag only for an older paired server's rows; these tests pin that path.
vi.mock('./worktrees/listing/owner-host-sidebar-inputs', () => ({
  ownerHostOwnsSidebarInputs: async () => false
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('worktree remote runtime mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it.each([
    [
      'updateWorktreeMeta',
      (store: ReturnType<typeof createTestStore>, worktreeId: string) =>
        store.getState().updateWorktreeMeta(worktreeId, { isUnread: true })
    ],
    [
      'updateWorktreesMeta',
      (store: ReturnType<typeof createTestStore>, worktreeId: string) =>
        store.getState().updateWorktreesMeta([{ worktreeId, updates: { isUnread: true } }])
    ],
    [
      'markAgentAttentionUnread',
      async (store: ReturnType<typeof createTestStore>, worktreeId: string) => {
        store.getState().markAgentAttentionUnread({
          workspaceId: worktreeId,
          subjectKey: null,
          groupId: null,
          reason: 'agent-completion'
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    ]
  ])('swallows a transport-wrapped selector miss in %s', async (_name, run) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    mockApi.worktrees.updateMeta.mockRejectedValue(
      new Error("Error invoking remote method 'worktrees:updateMeta': Error: selector_not_found")
    )
    store.setState({ worktreesByRepo: { repo1: [wt] } } as Partial<AppState>)

    try {
      await run(store, wt.id)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(mockApi.worktrees.updateMeta).toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      mockApi.worktrees.updateMeta.mockReset().mockResolvedValue({})
    }
  })

  it('clears folder workspace unread on its record and dedupes repeat calls', async () => {
    const store = createTestStore()
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-unread', isUnread: true })
    const folderKey = folderWorkspaceKey(folderWorkspace.id)
    store.setState({ folderWorkspaces: [folderWorkspace], projectGroups: [] })

    store
      .getState()
      .readOnScreenAttention({ workspaceIds: [folderKey], targets: [] }, { screenArrived: true })
    store
      .getState()
      .readOnScreenAttention({ workspaceIds: [folderKey], targets: [] }, { screenArrived: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(false)
    expect(store.getState().updateFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(store.getState().updateFolderWorkspace).toHaveBeenCalledWith(
      folderWorkspace.id,
      { isUnread: false },
      { executionHostId: 'local' }
    )
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('marks a folder workspace unread on its record', async () => {
    const store = createTestStore()
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-read' })
    const folderKey = folderWorkspaceKey(folderWorkspace.id)
    store.setState({ folderWorkspaces: [folderWorkspace], projectGroups: [] })

    store.getState().markAgentAttentionUnread({
      workspaceId: folderKey,
      subjectKey: null,
      groupId: null,
      reason: 'agent-completion'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getState().folderWorkspaces[0]).toEqual(
      expect.objectContaining({ isUnread: true, lastActivityAt: expect.any(Number) })
    )

    expect(store.getState().updateFolderWorkspace).toHaveBeenCalledWith(
      folderWorkspace.id,
      expect.objectContaining({ isUnread: true, lastActivityAt: expect.any(Number) }),
      { executionHostId: 'local' }
    )
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('drops a folder raise still waiting on its owner check once the folder is read', async () => {
    const store = createTestStore()
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-racing-unread' })
    const folderKey = folderWorkspaceKey(folderWorkspace.id)
    store.setState({ folderWorkspaces: [folderWorkspace], projectGroups: [] })

    store.getState().markAgentAttentionUnread({
      workspaceId: folderKey,
      subjectKey: null,
      groupId: null,
      reason: 'agent-completion'
    })
    store
      .getState()
      .readOnScreenAttention({ workspaceIds: [folderKey], targets: [] }, { screenArrived: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(false)
    expect(store.getState().updateFolderWorkspace).not.toHaveBeenCalledWith(
      folderWorkspace.id,
      expect.objectContaining({ isUnread: true }),
      expect.anything()
    )
  })

  // A rejected folder update reconciles the optimistic write away, so reporting
  // ok would show the dialog a save that silently undid itself.
  it('reports a rejected folder workspace update to the caller', async () => {
    const store = createTestStore()
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-rejected' })
    store.setState({ folderWorkspaces: [folderWorkspace], projectGroups: [] })
    const updateFolderWorkspace = vi.fn().mockResolvedValue(false)
    store.setState({ updateFolderWorkspace } as Partial<AppState>)

    const result = await store
      .getState()
      .updateWorktreeMeta(folderWorkspaceKey(folderWorkspace.id), { comment: 'note' })

    expect(updateFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: false, error: expect.any(String) })
  })

  it('reports a thrown folder workspace update instead of rejecting', async () => {
    const store = createTestStore()
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-throwing' })
    store.setState({ folderWorkspaces: [folderWorkspace], projectGroups: [] })
    const updateFolderWorkspace = vi.fn().mockRejectedValue(new Error('Runtime is offline'))
    store.setState({ updateFolderWorkspace } as Partial<AppState>)

    const result = await store
      .getState()
      .updateWorktreeMeta(folderWorkspaceKey(folderWorkspace.id), { comment: 'note' })

    expect(result).toEqual({ ok: false, error: 'Runtime is offline' })
  })
})
