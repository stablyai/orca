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
import {
  buildWorkspaceSessionHostSnapshots,
  patchWorkspaceSessionByHost,
  type SessionApi
} from './workspace-session-host-persistence'
import { buildWorkspaceSessionPayload, SESSION_RELEVANT_FIELDS } from './workspace-session'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'
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

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an unwritten partition is empty; readers only use the fields it names.
const EMPTY_PARTITION = {} as WorkspaceSessionState

/** Main's per-partition copy, saved the way main applies a window's entries patch. */
function inMemoryMain() {
  const partitions = new Map<string, WorkspaceSessionState>()
  const rejectNext = new Set<string>()
  const api: SessionApi = {
    get: async (hostId) => partitions.get(hostId ?? 'local') ?? EMPTY_PARTITION,
    patch: async () => {
      throw new Error('this window sends entries')
    },
    patchEntries: async (args, hostId) => {
      const key = hostId ?? 'local'
      if (rejectNext.delete(key)) {
        throw new Error('partition write failed')
      }
      const stored = partitions.get(key) ?? EMPTY_PARTITION
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
  return { api, holding, partitions, rejectNext }
}

function sshState(status: 'connected' | 'disconnected') {
  return { targetId: 'conn-1', status, error: null, reconnectAttempt: 0 }
}

describe('session fields a window clears', () => {
  it('no keyed field is ever written as undefined', () => {
    const store = createTestStore()
    seedStore(store, { worktreesByRepo: { [TEST_REPO.id]: [] } })
    const patch = buildWorkspaceSessionPatch(store.getState(), SESSION_RELEVANT_FIELDS)
    const ownershipByField: Readonly<Record<string, string>> = WORKSPACE_SESSION_FIELD_OWNERSHIP
    const dropped = Object.entries(patch)
      .filter(([field, value]) => {
        const ownership = ownershipByField[field]
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
        workspaceSessionReady: true,
        hydrationSucceeded: true
      })
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      const before = main.holding(WORKTREE_ID)
      expect(before.remoteSessionIdsByTabId).toEqual({ 'tab-a': 'relay-a' })
      expect(before.activeConnectionIdsAtShutdown).toEqual(['conn-1'])

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
    } finally {
      stop()
    }
  })
  it('a relay that ends without any tab change clears only its own id on the SSH partition, after a failed try', async () => {
    const { store, main, stop } = dormantRelaySaved(new AcknowledgedWorkspaceSessionEntries())
    try {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      const hostId = getRepoExecutionHostId(SSH_REPO)
      const saved = main.partitions.get(hostId)!
      // Another window's tab on the same host saved its own relay id.
      main.partitions.set(hostId, {
        ...saved,
        remoteSessionIdsByTabId: { ...saved.remoteSessionIdsByTabId, 'tab-b': 'relay-b' }
      })

      // The SSH partition rejects the first clear; the next store wake retries it.
      main.rejectNext.add(hostId)
      store.setState({ lastKnownRelayPtyIdByTabId: {} })
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      expect(main.holding(WORKTREE_ID).remoteSessionIdsByTabId).toEqual({
        'tab-a': 'relay-a',
        'tab-b': 'relay-b'
      })
      store.setState({ agentsFilterRepoIds: [] })
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

      expect(main.holding(WORKTREE_ID).remoteSessionIdsByTabId).toEqual({ 'tab-b': 'relay-b' })
    } finally {
      stop()
    }
  })

  it('the first save after launch clears a relay id saved before it, and keeps one main saved since', async () => {
    const main = inMemoryMain()
    const hostId = getRepoExecutionHostId(SSH_REPO)
    main.partitions.set(hostId, {
      ...EMPTY_PARTITION,
      tabsByWorktree: { [WORKTREE_ID]: [makeTab({ id: 'tab-a', worktreeId: WORKTREE_ID })] },
      remoteSessionIdsByTabId: { 'tab-gone': 'relay-gone' }
    })
    const acknowledged = new AcknowledgedWorkspaceSessionEntries()
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(main.api, [SSH_REPO])
    for (const [readHostId, partition] of read.wholeReadPartitions) {
      acknowledged.ownSavedKeys(readHostId, partition)
    }
    // A pane move in main saves a relay for another tab before this window's first save.
    const saved = main.partitions.get(hostId)!
    main.partitions.set(hostId, {
      ...saved,
      remoteSessionIdsByTabId: { ...saved.remoteSessionIdsByTabId, 'tab-b': 'relay-b' }
    })

    const { stop } = dormantRelaySaved(acknowledged, main)
    try {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      expect(main.holding(WORKTREE_ID).remoteSessionIdsByTabId).toEqual({
        'tab-a': 'relay-a',
        'tab-b': 'relay-b'
      })
    } finally {
      stop()
    }
  })

  it("clearing a tab's ended relay keeps the one main moved into that tab since", async () => {
    const acknowledged = new AcknowledgedWorkspaceSessionEntries()
    const { store, main, stop } = dormantRelaySaved(acknowledged)
    try {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      const hostId = getRepoExecutionHostId(SSH_REPO)
      // A pane move in main gives tab-a a surviving sibling's relay before this window hears of it.
      main.partitions.set(hostId, {
        ...main.partitions.get(hostId)!,
        remoteSessionIdsByTabId: { 'tab-a': 'relay-moved' }
      })

      store.setState({ lastKnownRelayPtyIdByTabId: {} })
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

      expect(main.holding(WORKTREE_ID).remoteSessionIdsByTabId).toEqual({ 'tab-a': 'relay-moved' })
    } finally {
      stop()
    }
  })

  it('a host whose relays this window cleared never gets the field whole again', async () => {
    const acknowledged = new AcknowledgedWorkspaceSessionEntries()
    const { store, main, stop } = dormantRelaySaved(acknowledged)
    try {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      store.setState({ lastKnownRelayPtyIdByTabId: {} })
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      buildWorkspaceSessionHostSnapshots(
        buildWorkspaceSessionPayload(store.getState()),
        store.getState(),
        acknowledged
      )
      const hostId = getRepoExecutionHostId(SSH_REPO)
      const saved = main.partitions.get(hostId)!
      main.partitions.set(hostId, { ...saved, remoteSessionIdsByTabId: { 'tab-b': 'relay-b' } })

      store.setState({ lastKnownRelayPtyIdByTabId: { 'tab-a': 'relay-c' } })
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

      expect(main.holding(WORKTREE_ID).remoteSessionIdsByTabId).toEqual({
        'tab-a': 'relay-c',
        'tab-b': 'relay-b'
      })
    } finally {
      stop()
    }
  })

  it('a relay that ends after a vetoed reload still clears', async () => {
    const acknowledged = new AcknowledgedWorkspaceSessionEntries()
    const { store, main, stop } = dormantRelaySaved(acknowledged)
    try {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      // Reload builds whole snapshots, then a dirty file vetoes unloading and the window stays.
      buildWorkspaceSessionHostSnapshots(
        buildWorkspaceSessionPayload(store.getState()),
        store.getState(),
        acknowledged
      )

      store.setState({ lastKnownRelayPtyIdByTabId: {} })
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

      expect(main.holding(WORKTREE_ID).remoteSessionIdsByTabId).toEqual({})
    } finally {
      stop()
    }
  })
})

/** A dormant tab reconnects through its last known relay; only that record changes when it ends. */
function dormantRelaySaved(
  acknowledged: AcknowledgedWorkspaceSessionEntries,
  main = inMemoryMain()
) {
  const store = createTestStore()
  const stop = createSessionWriteSubscriber({
    store,
    debounceMs: DEBOUNCE_MS,
    persist: ({ patch }) =>
      patchWorkspaceSessionByHost(main.api, patch, store.getState(), acknowledged).written
  })
  seedStore(store, {
    repos: [SSH_REPO],
    worktreesByRepo: {
      [SSH_REPO.id]: [makeWorktree({ id: WORKTREE_ID, repoId: SSH_REPO.id, path: '/remote/wt' })]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTab({ id: 'tab-a', worktreeId: WORKTREE_ID, ptyId: null })]
    },
    lastKnownRelayPtyIdByTabId: { 'tab-a': 'relay-a' },
    workspaceSessionReady: true,
    hydrationSucceeded: true
  })
  return { store, main, stop }
}
