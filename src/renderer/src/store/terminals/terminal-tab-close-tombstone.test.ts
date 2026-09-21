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

const REMOTE_WORKTREE = 'remote-repo::/srv/app'
const LOCAL_WORKTREE = 'local-repo::/tmp/app'

function storeWithBothWorktrees(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    repos: [
      { id: 'remote-repo', path: '/srv/app', name: 'app', connectionId: 'ssh-1' },
      { id: 'local-repo', path: '/tmp/app', name: 'app' }
    ] as never,
    worktreesByRepo: {
      'remote-repo': [
        makeWorktree({ id: REMOTE_WORKTREE, repoId: 'remote-repo', path: '/srv/app' })
      ],
      'local-repo': [makeWorktree({ id: LOCAL_WORKTREE, repoId: 'local-repo', path: '/tmp/app' })]
    },
    tabsByWorktree: {
      [REMOTE_WORKTREE]: [makeTab({ id: 'remote-tab', worktreeId: REMOTE_WORKTREE })],
      [LOCAL_WORKTREE]: [makeTab({ id: 'local-tab', worktreeId: LOCAL_WORKTREE })]
    }
  })
  return store
}

describe('closeTab close tombstones', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('records the closed tab against the worktree it was closed in', () => {
    const store = storeWithBothWorktrees()

    store.getState().closeTab('remote-tab')

    expect(store.getState().closedTerminalTabTombstonesByTabId['remote-tab']).toEqual({
      closedAt: expect.any(Number),
      worktreeId: REMOTE_WORKTREE
    })
  })

  // A tombstone outlives the host's own record, so the only claim it may ever make is "the user
  // closed this". Neither of these closes is that claim.
  it.each([['pty-exit'], ['cleanup']] as const)('records nothing for a %s close', (reason) => {
    const store = storeWithBothWorktrees()

    store.getState().closeTab('remote-tab', { reason })

    expect(store.getState().closedTerminalTabTombstonesByTabId['remote-tab']).toBeUndefined()
  })

  it('records nothing for a definitively local worktree, which no pull merge ever reads', () => {
    const store = storeWithBothWorktrees()

    store.getState().closeTab('local-tab')

    expect(store.getState().closedTerminalTabTombstonesByTabId).toEqual({})
  })
})
