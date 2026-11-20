import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { applyWorkspaceSessionEntriesPatch } from '../../../../../shared/workspace-session/workspace-session-entries-patch'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../../../../shared/workspace-session/workspace-session-host-field-ownership'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { createSessionWriteSubscriber } from './session-write-subscriber'
import { AcknowledgedWorkspaceSessionEntries } from './workspace-session-acknowledged-entries'
import { patchWorkspaceSessionByHost, type SessionApi } from './workspace-session-host-persistence'
import { SESSION_RELEVANT_FIELDS } from './workspace-session'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'

const DEBOUNCE_MS = 150
const SSH_REPO = { ...TEST_REPO, connectionId: 'conn-1' }
const WORKTREE_ID = `${SSH_REPO.id}::/remote/wt`

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Main's per-partition copy, saved the way main applies a window's entries patch. */
function inMemoryMain() {
  const partitions = new Map<string, WorkspaceSessionState>()
  const api: SessionApi = {
    get: async () => {
      throw new Error('not read in this flow')
    },
    patch: async () => {
      throw new Error('this window sends entries')
    },
    patchEntries: async (args, hostId) => {
      const key = hostId ?? 'local'
      const stored = partitions.get(key) ?? ({} as WorkspaceSessionState)
      partitions.set(key, { ...stored, ...applyWorkspaceSessionEntriesPatch(stored, args) })
      return { status: 'applied' }
    }
  }
  const holding = (worktreeId: string): WorkspaceSessionState => {
    const found = [...partitions.values()].find((session) =>
      Object.hasOwn(session.tabsByWorktree ?? {}, worktreeId)
    )
    if (!found) {
      throw new Error(`no partition holds ${worktreeId}`)
    }
    return found
  }
  return { api, holding }
}

function sshState(status: 'connected' | 'disconnected') {
  return { targetId: 'conn-1', status, error: null, reconnectAttempt: 0 }
}

describe('session fields a window clears', () => {
  it('no keyed field is ever written as undefined', () => {
    const store = createTestStore()
    seedStore(store, { worktreesByRepo: { [TEST_REPO.id]: [] } })
    const patch = buildWorkspaceSessionPatch(store.getState(), SESSION_RELEVANT_FIELDS)
    const dropped = Object.entries(patch)
      .filter(([field, value]) => {
        const ownership =
          WORKSPACE_SESSION_FIELD_OWNERSHIP[field as keyof typeof WORKSPACE_SESSION_FIELD_OWNERSHIP]
        return value === undefined && ownership !== 'global' && ownership !== 'hostPrivate'
      })
      .map(([field]) => field)
    // The host split skips undefined values, so main would keep the old ones.
    expect(dropped).toEqual([])
  })

  it('after the last SSH session ends, a restart finds nothing to reconnect', async () => {
    const store = createTestStore()
    const main = inMemoryMain()
    const acknowledged = new AcknowledgedWorkspaceSessionEntries()
    const stop = createSessionWriteSubscriber({
      store,
      debounceMs: DEBOUNCE_MS,
      persist: ({ patch }) =>
        patchWorkspaceSessionByHost(main.api, patch, store.getState(), acknowledged).written
    })
    try {
      seedStore(store, {
        repos: [SSH_REPO],
        worktreesByRepo: {
          [SSH_REPO.id]: [
            makeWorktree({ id: WORKTREE_ID, repoId: SSH_REPO.id, path: '/remote/wt' })
          ]
        },
        tabsByWorktree: {
          [WORKTREE_ID]: [makeTab({ id: 'tab-a', worktreeId: WORKTREE_ID, ptyId: 'relay-a' })]
        },
        ptyIdsByTabId: { 'tab-a': ['relay-a'] },
        sshConnectionStates: new Map([['conn-1', sshState('connected')]]),
        // The startup read loaded the SSH partition, so this window's saves speak for its reconnect facts.
        hydratedSshSessionHostIds: [getRepoExecutionHostId(SSH_REPO)],
        workspaceSessionReady: true,
        hydrationSucceeded: true
      })
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      const before = main.holding(WORKTREE_ID)
      expect(before.remoteSessionIdsByTabId).toEqual({ 'tab-a': 'relay-a' })
      expect(before.activeConnectionIdsAtShutdown).toEqual(['conn-1'])
      expect(before.activeWorktreeIdsOnShutdown).toEqual([WORKTREE_ID])

      // The remote shell exits and the user disconnects.
      store.setState((state) => ({
        tabsByWorktree: {
          [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID]!.map((tab) => ({ ...tab, ptyId: null }))
        },
        ptyIdsByTabId: {},
        sshConnectionStates: new Map([['conn-1', sshState('disconnected')]])
      }))
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

      // A crash before quit leaves this save as what the next launch restores from.
      const restored = main.holding(WORKTREE_ID)
      expect(restored.remoteSessionIdsByTabId).toEqual({})
      expect(restored.activeConnectionIdsAtShutdown).toBeUndefined()
      expect(restored.activeWorktreeIdsOnShutdown).toEqual([])
    } finally {
      stop()
    }
  })
})
