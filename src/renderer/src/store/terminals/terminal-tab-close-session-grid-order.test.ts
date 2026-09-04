import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeTab, makeWorktree, seedStore } from '../slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../slices/store-cascades-test-harness'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn<() => unknown[]>(() => [])
}))

vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

const mockApi = createStoreCascadesMockApi()
const WORKTREE = 'repo::/tmp/app'

function storeWithTabs(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    repos: [{ id: 'repo', path: '/tmp/app', name: 'app' }] as never,
    worktreesByRepo: { repo: [makeWorktree({ id: WORKTREE, repoId: 'repo', path: '/tmp/app' })] },
    tabsByWorktree: {
      [WORKTREE]: [
        makeTab({ id: 'tab-a', worktreeId: WORKTREE }),
        makeTab({ id: 'tab-b', worktreeId: WORKTREE })
      ]
    }
  })
  return store
}

describe('closeTab and the session grid order', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('drops the closed tab from the global grid order', () => {
    const store = storeWithTabs()
    store.setState({ sessionsGridTabOrder: ['tab-b', 'tab-a', 'other-workspace-tab'] })

    store.getState().closeTab('tab-a')

    expect(store.getState().sessionsGridTabOrder).toEqual(['tab-b', 'other-workspace-tab'])
  })

  it('leaves the order untouched — same reference — when the tab was never ordered', () => {
    const store = storeWithTabs()
    const order = ['other-workspace-tab']
    store.setState({ sessionsGridTabOrder: order })

    store.getState().closeTab('tab-a')

    // An unrelated close must not read as a persisted-UI edit.
    expect(store.getState().sessionsGridTabOrder).toBe(order)
  })
})
