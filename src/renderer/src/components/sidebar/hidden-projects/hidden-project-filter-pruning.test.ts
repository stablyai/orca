import { describe, expect, it } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { createTabsSliceMockApi } from '@/store/slices/tabs/tabs-slice-test-harness'
import { pruneHiddenProjectFilterIds } from './hidden-project-filter-pruning'

createTabsSliceMockApi()

describe('pruneHiddenProjectFilterIds', () => {
  it('drops filter ids whose every copy is hidden and keeps the rest', () => {
    const store = createTestStore()
    store.setState({
      persistedUIReady: true,
      repos: [
        { ...TEST_REPO, id: 'gone', hiddenAt: 1 },
        { ...TEST_REPO, id: 'split', hiddenAt: 1 },
        { ...TEST_REPO, id: 'split', connectionId: 'box' },
        { ...TEST_REPO, id: 'kept' }
      ],
      filterRepoIds: ['gone', 'split', 'kept'],
      agentsFilterRepoIds: ['gone']
    })

    pruneHiddenProjectFilterIds(store.getState())

    // 'split' still has a listed copy on the SSH box, so its filter stays.
    expect(store.getState().filterRepoIds).toEqual(['split', 'kept'])
    expect(store.getState().agentsFilterRepoIds).toEqual([])
  })
})
