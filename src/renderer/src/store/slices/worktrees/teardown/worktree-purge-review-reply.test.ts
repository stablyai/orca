import { expect, it, vi } from 'vitest'
import type { Tab } from '../../../../../../shared/tab-types'
import { watchStructuredReviewReplySettled } from '@/lib/structured-agent-session-review-reply-settled'
import { createStoreCascadesMockApi } from '../../store-cascades-test-harness'
import { createTestStore, makeWorktree, seedStore } from '../../store-test-helpers'
import { buildWorktreePurgeState } from './worktree-purge-state'

const WORKTREE_ID = 'repo1::/path/wt1'

createStoreCascadesMockApi()

const chat: Tab = {
  id: 'agent-session:chat-1',
  entityId: 'chat-1',
  groupId: 'group-1',
  worktreeId: WORKTREE_ID,
  contentType: 'agent-session',
  agentSessionAgent: 'claude',
  label: 'Claude Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

it("lets go of a review reply's wait on a chat when its worktree is purged", () => {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    },
    unifiedTabsByWorktree: { [WORKTREE_ID]: [chat] }
  })
  const released = vi.fn()
  const settled = vi.fn()
  watchStructuredReviewReplySettled('chat-1', settled, { holdRead: () => released })

  store.setState(buildWorktreePurgeState(store.getState(), [WORKTREE_ID]))

  expect(released).toHaveBeenCalledOnce()
})
