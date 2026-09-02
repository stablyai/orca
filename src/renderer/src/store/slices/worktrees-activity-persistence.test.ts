import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeFolderWorkspace, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall,
  worktreeListMock
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

beforeEach(resetWorktreeSliceModuleMemory)

describe('worktree remote runtime mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('does not surface remote selector misses while persisting activity timestamps', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-set',
      ok: false,
      error: { code: 'selector_not_found', message: 'selector_not_found' },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    try {
      store.getState().bumpWorktreeActivity(wt.id)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'worktree.set',
        params: expect.objectContaining({
          worktree: `id:${wt.id}`,
          lastActivityAt: expect.any(Number)
        }),
        timeoutMs: 15_000
      })
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  // Why: Electron IPC re-wraps the main-process message and drops the cause, so the quiet
  // "row is gone" handling must survive a transport that only leaves the token in the text.
  it('stays quiet when a transport-wrapped selector miss rejects the activity write', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    mockApi.worktrees.updateMeta.mockRejectedValueOnce(
      new Error("Error invoking remote method 'worktrees:updateMeta': Error: selector_not_found")
    )
    store.setState({ worktreesByRepo: { repo1: [wt] } } as Partial<AppState>)

    try {
      store.getState().bumpWorktreeActivity(wt.id)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(mockApi.worktrees.updateMeta).toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(worktreeListMock).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
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
      'markWorktreeUnread',
      async (store: ReturnType<typeof createTestStore>, worktreeId: string) => {
        store.getState().markWorktreeUnread(worktreeId)
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

  it('does not persist activity for a missing worktree', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [] }
    } as Partial<AppState>)

    store.getState().bumpWorktreeActivity('repo1::/missing')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('persists activity on the folder workspace record instead of failing on owner routing (#10251)', async () => {
    const store = createTestStore()
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-local' })
    const folderKey = folderWorkspaceKey(folderWorkspace.id)
    store.setState({
      folderWorkspaces: [folderWorkspace],
      worktreesByRepo: { repo1: [] }
    } as Partial<AppState>)
    const sortEpochBefore = store.getState().sortEpoch

    expect(() => store.getState().bumpWorktreeActivity(folderKey)).not.toThrow()
    expect(store.getState().folderWorkspaces[0]?.lastActivityAt).toEqual(expect.any(Number))
    expect(store.getState().sortEpoch).toBe(sortEpochBefore + 1)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    // Why: worktreeMeta['folder:…'] rows are write-only — folder meta must land on the FolderWorkspace record.
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(store.getState().updateFolderWorkspace).toHaveBeenCalledWith(
      folderWorkspace.id,
      expect.objectContaining({ lastActivityAt: expect.any(Number) })
    )
  })

  it('skips the sort-epoch bump when the active folder workspace reports activity', async () => {
    const store = createTestStore()
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-active' })
    const folderKey = folderWorkspaceKey(folderWorkspace.id)
    store.setState({
      folderWorkspaces: [folderWorkspace],
      activeWorktreeId: folderKey
    } as Partial<AppState>)
    const sortEpochBefore = store.getState().sortEpoch

    store.getState().bumpWorktreeActivity(folderKey)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.getState().updateFolderWorkspace).toHaveBeenCalledWith(
      folderWorkspace.id,
      expect.objectContaining({ lastActivityAt: expect.any(Number) })
    )
    expect(store.getState().sortEpoch).toBe(sortEpochBefore)
  })

  it('clears folder workspace unread on its record and dedupes repeat calls', async () => {
    const store = createTestStore()
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-unread', isUnread: true })
    const folderKey = folderWorkspaceKey(folderWorkspace.id)
    store.setState({ folderWorkspaces: [folderWorkspace] } as Partial<AppState>)

    store.getState().clearWorktreeUnread(folderKey)
    store.getState().clearWorktreeUnread(folderKey)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(false)
    expect(store.getState().updateFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(store.getState().updateFolderWorkspace).toHaveBeenCalledWith(folderWorkspace.id, {
      isUnread: false
    })
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('marks a folder workspace unread on its record', async () => {
    const store = createTestStore()
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-read' })
    const folderKey = folderWorkspaceKey(folderWorkspace.id)
    store.setState({ folderWorkspaces: [folderWorkspace] } as Partial<AppState>)

    store.getState().markWorktreeUnread(folderKey)
    expect(store.getState().folderWorkspaces[0]).toEqual(
      expect.objectContaining({ isUnread: true, lastActivityAt: expect.any(Number) })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.getState().updateFolderWorkspace).toHaveBeenCalledWith(
      folderWorkspace.id,
      expect.objectContaining({ isUnread: true, lastActivityAt: expect.any(Number) })
    )
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('clears a folder unread mark even when persistence has not settled yet', () => {
    const store = createTestStore()
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-racing-unread' })
    const folderKey = folderWorkspaceKey(folderWorkspace.id)
    store.setState({ folderWorkspaces: [folderWorkspace] } as Partial<AppState>)

    store.getState().markWorktreeUnread(folderKey)
    store.getState().clearWorktreeUnread(folderKey)

    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(false)
    expect(store.getState().updateFolderWorkspace).toHaveBeenNthCalledWith(
      1,
      folderWorkspace.id,
      expect.objectContaining({ isUnread: true })
    )
    expect(store.getState().updateFolderWorkspace).toHaveBeenNthCalledWith(2, folderWorkspace.id, {
      isUnread: false
    })
  })

  // A rejected folder update reconciles the optimistic write away, so reporting
  // ok would show the dialog a save that silently undid itself.
  it('reports a rejected folder workspace update to the caller', async () => {
    const store = createTestStore()
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-rejected' })
    store.setState({ folderWorkspaces: [folderWorkspace] } as Partial<AppState>)
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
    store.setState({ folderWorkspaces: [folderWorkspace] } as Partial<AppState>)
    const updateFolderWorkspace = vi.fn().mockRejectedValue(new Error('Runtime is offline'))
    store.setState({ updateFolderWorkspace } as Partial<AppState>)

    const result = await store
      .getState()
      .updateWorktreeMeta(folderWorkspaceKey(folderWorkspace.id), { comment: 'note' })

    expect(result).toEqual({ ok: false, error: 'Runtime is offline' })
  })

  it('persists activity for hidden detected worktrees', async () => {
    const store = createTestStore()
    const hidden = makeWorktree({
      id: 'repo1::/path/hidden',
      repoId: 'repo1',
      path: '/path/hidden'
    })
    const detected = makeDetectedResult('repo1', [hidden])
    detected.worktrees[0] = { ...detected.worktrees[0], ownership: 'external', visible: false }
    store.setState({
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: { repo1: detected }
    } as Partial<AppState>)

    store.getState().bumpWorktreeActivity(hidden.id)

    expect(
      store.getState().detectedWorktreesByRepo.repo1.worktrees[0].lastActivityAt
    ).toBeGreaterThan(hidden.lastActivityAt)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: hidden.id,
        updates: expect.objectContaining({ lastActivityAt: expect.any(Number) })
      })
    )
  })
})
