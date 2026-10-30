import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  mockApi,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'
import { makeWorktree } from './worktrees-slice-test-fixtures'

beforeEach(() => {
  vi.clearAllMocks()
  resetWorktreeSliceModuleMemory()
  mockApi.hooks.check.mockResolvedValue({ hasHooks: false, hooks: null, mayNeedUpdate: false })
})

describe('archive state publication', () => {
  it.each([
    null,
    { isArchived: false, instanceId: 'selected' },
    { isArchived: true, instanceId: 'replacement' }
  ])('does not publish unconfirmed archive metadata: %j', async (reply) => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      isArchived: false,
      instanceId: 'selected'
    })
    mockApi.worktrees.updateMeta.mockResolvedValue(reply)
    store.setState({ worktreesByRepo: { repo1: [wt] }, fetchWorktrees: vi.fn() })
    const result = await store.getState().updateWorktreeMeta(wt.id, { isArchived: true })
    expect(result.ok).toBe(false)
    expect(store.getState().worktreesByRepo.repo1[0].isArchived).toBe(false)
  })
  it.each([
    { succeeds: true, batch: false },
    { succeeds: false, batch: false },
    { succeeds: true, batch: true },
    { succeeds: false, batch: true }
  ])('waits for archive confirmation: $succeeds, batch: $batch', async ({ succeeds, batch }) => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      isArchived: false,
      instanceId: 'archive-instance'
    })
    const completion = Promise.withResolvers<{ isArchived: boolean; instanceId: string }>()
    mockApi.worktrees.updateMeta.mockReturnValue(completion.promise)
    store.setState({ worktreesByRepo: { repo1: [wt] }, fetchWorktrees: vi.fn() })
    const operation = batch
      ? store
          .getState()
          .updateWorktreesMeta([{ worktreeId: wt.id, updates: { isArchived: true } }])
          .then(
            () => ({ ok: true }),
            () => ({ ok: false })
          )
      : store.getState().updateWorktreeMeta(wt.id, { isArchived: true })
    await vi.waitFor(() => expect(mockApi.worktrees.updateMeta).toHaveBeenCalled())
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({ expectedInstanceId: 'archive-instance' })
    )
    expect(store.getState().worktreesByRepo.repo1[0].isArchived).toBe(false)
    if (succeeds) {
      completion.resolve({ isArchived: true, instanceId: 'archive-instance' })
    } else {
      completion.reject(new Error('Archive hook did not confirm stopped execution'))
    }
    expect((await operation).ok).toBe(succeeds)
    expect(store.getState().worktreesByRepo.repo1[0].isArchived).toBe(succeeds)
  })
})
