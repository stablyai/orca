import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { applyWorkspaceSessionEntriesPatch } from '../../../../../shared/workspace-session/workspace-session-entries-patch'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { SshConnectionStatus } from '../../../../../shared/remote-runtime/ssh/ssh-types'
import { getDefaultWorkspaceSession } from '../../../../../shared/orca-profiles/constants'
import { AcknowledgedWorkspaceSessionEntries } from './workspace-session-acknowledged-entries'
import type { SessionApi } from './workspace-session-host-persistence'
import { subscribeWorkspaceSessionHostWrites } from './workspace-session-host-write-subscriber'

const DEBOUNCE_MS = 150

function sshTarget(status: SshConnectionStatus) {
  return new Map([['c', { targetId: 'c', status, error: null, reconnectAttempt: 0 }]])
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

it('a title save after an SSH disconnect clears the remote partition’s reconnect targets', async () => {
  const partitions = new Map<string, WorkspaceSessionState>()
  const api: SessionApi = {
    get: async () => {
      throw new Error('not read in this flow')
    },
    patch: async () => {},
    patchEntries: async (patch, hostId = 'local') => {
      const before = partitions.get(hostId) ?? getDefaultWorkspaceSession()
      partitions.set(hostId, { ...before, ...applyWorkspaceSessionEntriesPatch(before, patch) })
      return { status: 'applied' }
    }
  }
  const store = createTestStore()
  const stop = subscribeWorkspaceSessionHostWrites({
    store,
    api,
    acknowledged: new AcknowledgedWorkspaceSessionEntries(),
    debounceMs: DEBOUNCE_MS
  })
  try {
    const worktree = makeWorktree({ id: `${TEST_REPO.id}::/wt`, repoId: TEST_REPO.id, path: '/wt' })
    seedStore(store, {
      repos: [{ ...TEST_REPO, connectionId: 'c' }],
      worktreesByRepo: { [TEST_REPO.id]: [worktree] },
      activeWorktreeId: worktree.id
    })
    store.getState().createTab(worktree.id, undefined, undefined, { id: 'tab' })
    store.setState({
      sshConnectionStates: sshTarget('connected'),
      workspaceSessionReady: true,
      hydrationSucceeded: true
    })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    store.setState({ sshConnectionStates: sshTarget('disconnected') })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    store.getState().updateTabTitle('tab', 'Renamed')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    const remote = partitions.get('ssh:c')
    expect(remote?.tabsByWorktree?.[worktree.id]?.[0]?.title).toBe('Renamed')
    expect(remote?.activeConnectionIdsAtShutdown).toBeUndefined()
  } finally {
    stop()
  }
})
