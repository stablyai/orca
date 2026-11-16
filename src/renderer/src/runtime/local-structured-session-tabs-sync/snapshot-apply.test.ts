// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { createTestStore, seedStore } from '../../store/testing/app-store-test-fixture'
import { makeWorktree } from '../../store/slices/worktrees/worktree.test-fixture'
import { createStoreCascadesMockApi } from '../../store/testing/app-store-cascade-api.test-fixture'
import { applyLocalStructuredSessionTabSnapshots } from './snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from './inventory-generation-fence'

const mocks = vi.hoisted((): { store: unknown } => ({ store: null }))
vi.mock('@/store/index', () => ({
  get useAppStore() {
    return mocks.store
  }
}))
createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'

afterEach(() => resetLocalStructuredSessionVersionForTests())

const frame = (snapshotVersion: number, sessions: string[]): RuntimeMobileSessionTabsResult => ({
  worktree: WT,
  publicationEpoch: 'host:1',
  snapshotVersion,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabs: sessions.map((sessionId) => ({
    type: 'agent-session' as const,
    id: `chat-${sessionId}`,
    title: sessionId,
    sessionId,
    agent: 'claude' as const,
    isActive: false
  }))
})

it('skips reconciliation for a stream frame that differs from the applied one only in version', () => {
  const store = createTestStore()
  mocks.store = store
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    unifiedTabsByWorktree: { [WT]: [] }
  })
  const stream = { skipVersionOnlyRepeats: true }
  const apply = (state: ReturnType<typeof store.getState>, next: RuntimeMobileSessionTabsResult) =>
    applyLocalStructuredSessionTabSnapshots(state, [next], undefined, 0, stream)
  const chats = (state: ReturnType<typeof store.getState>) =>
    state.unifiedTabsByWorktree[WT]?.map((tab) => tab.entityId)
  const applied = apply(store.getState(), frame(1, ['s1']))
  expect(chats(applied)).toEqual(['s1'])
  expect(apply(applied, frame(2, ['s1']))).toBe(applied)
  expect(chats(apply(applied, frame(3, ['s1', 's2'])))).toEqual(['s1', 's2'])
})
