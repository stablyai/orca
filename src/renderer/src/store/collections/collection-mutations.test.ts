import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../testing/app-store-test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'

const collectionsDelete = vi.fn()
const uiSet = vi.fn()

describe('collection mutations', () => {
  beforeEach(() => {
    collectionsDelete.mockReset().mockResolvedValue(true)
    uiSet.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: { collections: { delete: collectionsDelete }, ui: { set: uiSet } }
    })
  })

  it('removes collection collapse keys and memberships when deleting a collection', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'wt-1',
      repoId: 'repo-1',
      collectionIds: ['collection-1', 'collection-2']
    })
    store.setState({
      collections: [
        { id: 'collection-1', name: 'One' },
        { id: 'collection-2', name: 'Two' }
      ] as never,
      worktreesByRepo: { 'repo-1': [worktree] },
      collapsedGroups: new Set([
        'collection:collection-1',
        'collection:collection-1:repo:repo-1',
        'collection:collection-2'
      ])
    })

    await expect(store.getState().deleteCollection('collection-1')).resolves.toBe(true)

    expect(collectionsDelete).toHaveBeenCalledWith({ collectionId: 'collection-1' })
    expect(store.getState().collections).toEqual([expect.objectContaining({ id: 'collection-2' })])
    expect(store.getState().worktreesByRepo['repo-1']?.[0]?.collectionIds).toEqual(['collection-2'])
    expect([...store.getState().collapsedGroups]).toEqual(['collection:collection-2'])
    expect(uiSet).toHaveBeenCalledWith({ collapsedGroups: ['collection:collection-2'] })
  })
})
