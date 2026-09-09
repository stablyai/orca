import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { getOrphanTerminalIds } from '../slices/terminal-orphan-helpers'
import { createTestStore, makeTab, makeWorktree } from '../slices/store-test-helpers'

const TARGET_ID = 'target'
const REPO_ID = 'repo-ssh'
const WORKTREE_ID = `${REPO_ID}::/work/demo`
const TAB_ID = 'tab-ssh'
const RELAY_PTY_ID = 'ssh:target@@pty-42'

function connectedSshState(status: 'connected' | 'disconnected') {
  return new Map([
    [TARGET_ID, { targetId: TARGET_ID, status, error: null, reconnectAttempt: 0 }]
  ]) as never
}

function seedStore(status: 'connected' | 'disconnected' = 'connected') {
  const store = createTestStore()
  store.setState({
    repos: [
      {
        id: REPO_ID,
        path: '/work/demo',
        displayName: 'demo',
        badgeColor: '#000',
        addedAt: 1,
        connectionId: TARGET_ID,
        executionHostId: 'ssh:target'
      }
    ],
    worktreesByRepo: {
      [REPO_ID]: [
        makeWorktree({
          id: WORKTREE_ID,
          repoId: REPO_ID,
          path: '/work/demo',
          hostId: 'ssh:target'
        })
      ]
    },
    sshConnectionStates: connectedSshState(status),
    sshTargetsHydrated: true,
    sshTargetLabels: new Map([[TARGET_ID, 'demo host']]),
    hydrationSucceeded: true
  })
  return store
}

/** What the previous run wrote: a live relay session recorded on the row AND in the id map. */
function persistedSession(): WorkspaceSessionState {
  return {
    activeRepoId: REPO_ID,
    activeWorktreeId: WORKTREE_ID,
    activeTabId: TAB_ID,
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID, ptyId: RELAY_PTY_ID })]
    },
    terminalLayoutsByTabId: {},
    activeWorktreeIdsOnShutdown: [WORKTREE_ID],
    activeTabIdByWorktree: { [WORKTREE_ID]: TAB_ID },
    remoteSessionIdsByTabId: { [TAB_ID]: RELAY_PTY_ID },
    activeConnectionIdsAtShutdown: [TARGET_ID]
  }
}

describe('restored relay session identity (#17743)', () => {
  it('does not republish a hydration-nulled ptyId over the persisted relay session id', () => {
    const store = seedStore()
    store.getState().hydrateWorkspaceSession(persistedSession())

    // Hydration deliberately nulls the row; that is the contract, not the bug.
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].ptyId).toBeNull()
    expect(store.getState().ptyIdsByTabId[TAB_ID]).toEqual([])
    expect(store.getState().lastKnownRelayPtyIdByTabId[TAB_ID]).toBeUndefined()

    const payload = buildWorkspaceSessionPayload(store.getState())

    expect(payload.remoteSessionIdsByTabId).toEqual({ [TAB_ID]: RELAY_PTY_ID })
    expect(payload.activeWorktreeIdsOnShutdown).toContain(WORKTREE_ID)
    expect(payload.activeConnectionIdsAtShutdown).toEqual([TARGET_ID])
  })

  it('rebinds the restored tab to its live relay PTY and keeps publishing that id', async () => {
    const store = seedStore()
    store.getState().hydrateWorkspaceSession(persistedSession())

    await store.getState().reconnectPersistedTerminals()

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].ptyId).toBe(RELAY_PTY_ID)
    expect(store.getState().ptyIdsByTabId[TAB_ID]).toEqual([RELAY_PTY_ID])
    expect(buildWorkspaceSessionPayload(store.getState()).remoteSessionIdsByTabId).toEqual({
      [TAB_ID]: RELAY_PTY_ID
    })
  })

  it('keeps a deferred relay session id after a disconnect clears the row binding', async () => {
    const store = seedStore('disconnected')
    store.getState().hydrateWorkspaceSession(persistedSession())
    await store.getState().reconnectPersistedTerminals()

    expect(store.getState().deferredSshSessionIdsByTabId[TAB_ID]).toBe(RELAY_PTY_ID)

    // A relay drop clears the row binding. Loss of contact is not evidence the remote PTY exited,
    // so the handle must survive into the next write.
    store.getState().clearDirectSshTargetPtyBindings(TARGET_ID)

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].ptyId).toBeNull()
    expect(store.getState().ptyIdsByTabId[TAB_ID]).toEqual([])
    expect(buildWorkspaceSessionPayload(store.getState()).remoteSessionIdsByTabId).toEqual({
      [TAB_ID]: RELAY_PTY_ID
    })
  })

  it('leaves a tab whose relay handle is unverifiable alone instead of retiring it', async () => {
    const store = seedStore('disconnected')
    store.getState().hydrateWorkspaceSession(persistedSession())
    await store.getState().reconnectPersistedTerminals()
    store.getState().clearDirectSshTargetPtyBindings(TARGET_ID)

    // No live PTY, no row binding, host unreachable — `unverifiable`, never `exited`.
    expect([...getOrphanTerminalIds(store.getState(), WORKTREE_ID)]).toEqual([])
    expect(store.getState().tabsByWorktree[WORKTREE_ID].map((tab) => tab.id)).toEqual([TAB_ID])
  })

  it('does not invent a session id for a tab that never had one', () => {
    const store = seedStore()
    const session = persistedSession()
    session.tabsByWorktree[WORKTREE_ID] = [
      makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID, ptyId: null })
    ]
    delete session.remoteSessionIdsByTabId
    delete session.activeConnectionIdsAtShutdown
    session.activeWorktreeIdsOnShutdown = []
    store.getState().hydrateWorkspaceSession(session)

    const payload = buildWorkspaceSessionPayload(store.getState())

    expect(payload.remoteSessionIdsByTabId).toBeUndefined()
    expect(payload.activeWorktreeIdsOnShutdown).toEqual([])
  })
})
