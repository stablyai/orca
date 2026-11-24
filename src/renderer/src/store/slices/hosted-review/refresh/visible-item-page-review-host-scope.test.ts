// An open item page's PR workspaces refresh whatever host the left sidebar is filtered to.
import { describe, expect, it } from 'vitest'
import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { makeWorktree } from '../../worktrees/worktree.test-fixture'
import type { AppState } from '../../../types'
import { visibleReviewWorktreeIdsForState } from './use-visible-review-refresh-reporting'

const LOCAL_ID = 'repo1::/repo1/worker'

function seeded(state: Partial<AppState>) {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: LOCAL_ID, repoId: 'repo1', path: '/repo1/worker' })]
    },
    visibleWorkspaceHostIds: ['runtime:other-host'],
    ...state
  } as Partial<AppState>)
  return store.getState()
}

describe('item page review visibility under a sidebar host filter', () => {
  it('keeps item-page workspaces on another host and still filters sidebar rows', () => {
    expect(
      visibleReviewWorktreeIdsForState(seeded({ visibleItemPageReviewWorktreeIds: [LOCAL_ID] }))
    ).toEqual([LOCAL_ID])
    expect(
      visibleReviewWorktreeIdsForState(seeded({ visibleReviewCardWorktreeIds: [LOCAL_ID] }))
    ).toEqual([])
  })
})
