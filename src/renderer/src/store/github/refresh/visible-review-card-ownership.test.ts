import { expect, it } from 'vitest'
import { createTestStore } from '../../testing/app-store-test-fixture'

it('keeps visible review reports owned by other lists through interleaved publication and cleanup', () => {
  const store = createTestStore()
  const publish = store.getState().setVisibleReviewCardWorktreeIds
  publish(['project', 'shared'], 'projects')
  publish([], 'chats')
  expect(store.getState().visibleReviewCardWorktreeIds).toEqual(['project', 'shared'])
  publish(['chat', 'shared'], 'chats')
  expect(store.getState().visibleReviewCardWorktreeIds).toEqual(['project', 'shared', 'chat'])
  publish([], 'projects')
  expect(store.getState().visibleReviewCardWorktreeIds).toEqual(['chat', 'shared'])
  publish([], 'chats')
  expect(store.getState().visibleReviewCardWorktreeIds).toEqual([])
})
