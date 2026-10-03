import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  seedStore,
  TEST_REPO
} from '../slices/store-test-helpers'
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
      {
        ...TEST_REPO,
        id: 'remote-repo',
        path: '/srv/app',
        displayName: 'app',
        connectionId: 'ssh-1'
      },
      { ...TEST_REPO, id: 'local-repo', path: '/tmp/app', displayName: 'app' }
    ],
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

describe('retireDirectSshTerminalsForRelayGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('closes SSH terminal tabs for the updated host and leaves local tabs alone', () => {
    const store = storeWithBothWorktrees()

    expect(store.getState().retireDirectSshTerminalsForRelayGeneration('ssh-1')).toBe(1)

    expect(store.getState().tabsByWorktree[REMOTE_WORKTREE]).toEqual([])
    expect(store.getState().tabsByWorktree[LOCAL_WORKTREE]?.map((tab) => tab.id)).toEqual([
      'local-tab'
    ])
    expect(store.getState().closedTerminalTabTombstonesByTabId['remote-tab']).toBeUndefined()
  })

  it('is a no-op for a host with no terminal tabs', () => {
    const store = storeWithBothWorktrees()
    expect(store.getState().retireDirectSshTerminalsForRelayGeneration('ssh-other')).toBe(0)
    expect(store.getState().tabsByWorktree[REMOTE_WORKTREE]?.map((tab) => tab.id)).toEqual([
      'remote-tab'
    ])
  })
})
