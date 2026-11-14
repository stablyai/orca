import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../worktrees-slice-test-harness'

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
  })
})
