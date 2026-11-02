import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getWorkspaceAttachments,
  normalizeWorkspaceAttachmentUpdate
} from '../../../../shared/workspace-attachments'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeFolderWorkspace, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
})

describe('workspace attachment collections', () => {
  it('retains earlier reviews locally while persisting a compatible scalar mutation', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/work', repoId: 'repo1', linkedPR: 42 })
    store.setState({ worktreesByRepo: { repo1: [wt] } })
    await store.getState().updateWorktreeMeta(wt.id, { linkedGitLabMR: 7 })
    const saved = store.getState().worktreesByRepo.repo1[0]
    expect(saved.linkedPR).toBeNull()
    expect(saved.linkedGitLabMR).toBe(7)
    expect(getWorkspaceAttachments(saved)).toEqual([
      { provider: 'github', type: 'pr', number: 42 },
      { provider: 'gitlab', type: 'mr', number: 7 }
    ])
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: expect.objectContaining({ linkedGitLabMR: 7 })
      })
    )
    const updates = mockApi.worktrees.updateMeta.mock.lastCall?.[0].updates
    expect(updates).not.toHaveProperty('linkedItems')
    expect(updates).not.toHaveProperty('linkedItemsBase')
    expect(updates).not.toHaveProperty('linkedPR')
    const persisted = normalizeWorkspaceAttachmentUpdate(wt, updates ?? {})
    expect(persisted.linkedItems).toEqual(saved.linkedItems)
    expect(persisted.linkedPR).toBeNull()
    expect(persisted.linkedGitLabMR).toBe(7)
  })

  it('carries the editor snapshot unchanged through optimistic state and host persistence', async () => {
    const store = createTestStore()
    const base = [1, 2].map((number) => ({ provider: 'github', type: 'pr', number }) as const)
    const peer = { provider: 'github', type: 'pr', number: 3 } as const
    const wt = makeWorktree({
      id: 'repo1::/work',
      repoId: 'repo1',
      linkedPR: 2,
      linkedItems: [...base, peer]
    })
    store.setState({ worktreesByRepo: { repo1: [wt] } })
    await store
      .getState()
      .updateWorktreeMeta(wt.id, { linkedItemsBase: base, linkedItems: [base[1]] })
    expect(store.getState().worktreesByRepo.repo1[0].linkedItems).toEqual([base[1], peer])
    const write = mockApi.worktrees.updateMeta.mock.lastCall?.[0].updates
    expect(write).toMatchObject({ linkedItemsBase: base, linkedItems: [base[1]] })
    // A peer can remove its addition after our optimistic merge but before the host write.
    expect(
      normalizeWorkspaceAttachmentUpdate({ linkedItems: base }, write ?? {}).linkedItems
    ).toEqual([base[1]])
  })

  it('removes a secondary review without disturbing the active review or task', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/work',
      repoId: 'repo1',
      linkedPR: 42,
      linkedIssue: 9,
      linkedItems: [
        { provider: 'github', type: 'pr', number: 42 },
        { provider: 'github', type: 'pr', number: 43 },
        { provider: 'github', type: 'issue', number: 9 }
      ]
    })
    store.setState({ worktreesByRepo: { repo1: [wt] } })
    await store.getState().updateWorktreeMeta(wt.id, {
      linkedItems: wt.linkedItems?.filter((item) => item.number !== 43)
    })
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      linkedPR: 42,
      linkedIssue: 9
    })
    expect(getWorkspaceAttachments(store.getState().worktreesByRepo.repo1[0])).toHaveLength(2)
  })

  it('routes folder links to the owning folder update instead of dropping them', async () => {
    const store = createTestStore()
    const folder = makeFolderWorkspace()
    const updateFolderWorkspace = vi.fn().mockResolvedValue(true)
    store.setState({ folderWorkspaces: [folder], updateFolderWorkspace })
    const linkedItems = [
      { provider: 'linear', type: 'issue', number: 0, identifier: 'ENG-42' }
    ] as const
    const result = await store.getState().updateWorktreeMeta(folderWorkspaceKey(folder.id), {
      linkedItems: [...linkedItems]
    })
    expect(result).toEqual({ ok: true })
    expect(updateFolderWorkspace).toHaveBeenCalledWith(
      folder.id,
      expect.objectContaining({ linkedItems }),
      { executionHostId: 'local' }
    )
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })
})
