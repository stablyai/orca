import { describe, expect, it, vi } from 'vitest'
import { createTestStore, makeWorktree } from './store-test-helpers'
import {
  collectionsCreate,
  installReposRuntimeRoutingHarness,
  remoteRepo,
  runtimeEnvironmentCall,
  uiSet
} from './repos-runtime-routing-fixture'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

installReposRuntimeRoutingHarness()

describe('repo slice collections', () => {
  it('removes collection collapse keys when deleting a collection', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-collection',
      ok: true,
      result: { deleted: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'wt-1',
      repoId: remoteRepo.id,
      collectionIds: ['collection-1', 'collection-2']
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      collections: [
        { id: 'collection-1', name: 'One' },
        { id: 'collection-2', name: 'Two' }
      ] as never,
      worktreesByRepo: { [remoteRepo.id]: [worktree] },
      collapsedGroups: new Set([
        'collection:collection-1',
        'collection:collection-1:repo:remote-repo',
        'collection:collection-2'
      ])
    })

    await expect(store.getState().deleteCollection('collection-1')).resolves.toBe(true)

    expect(store.getState().collections).toEqual([expect.objectContaining({ id: 'collection-2' })])
    expect(store.getState().worktreesByRepo[remoteRepo.id]?.[0]?.collectionIds).toEqual([
      'collection-2'
    ])
    expect([...store.getState().collapsedGroups]).toEqual(['collection:collection-2'])
    expect(uiSet).toHaveBeenCalledWith({ collapsedGroups: ['collection:collection-2'] })
  })

  it('does not add a collection when the preload returns no result', async () => {
    collectionsCreate.mockResolvedValue(undefined)
    const store = createTestStore()

    await expect(store.getState().createCollection('Approve PRs')).resolves.toBeNull()

    expect(store.getState().collections).toEqual([])
  })
})
