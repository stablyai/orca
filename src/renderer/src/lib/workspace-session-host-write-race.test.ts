/**
 * GAP-03 Write Race Protection (revive_labs#962 / stablyai/orca#22038, PR #968 deferred scenario):
 * does the client's own wake-triggered session write (`persistWorkspaceSessionByHost`) undo a
 * server-side tab close it just correctly declined to adopt?
 *
 * `projects/orca-serve-tab-lifecycle/upstream/filing-drafts/GAP-03-offline-client-reconciliation.md`
 * §2 row 6 ("Step 4: Close & Teardown") describes the defect as: "Client write race overwrites
 * server-side tab close operations ... `patchWorkspaceSessionByHost` fires on client wake, racing
 * against server event streams." The proposed fix (§5.2) was a `hasPendingReconnectionHandshake`
 * write-gate on `persistWorkspaceSessionByHost` that defers any write until an authoritative
 * reconnect handshake settles.
 *
 * This suite answers, with test evidence, whether that gate is actually necessary given the
 * shipped fix's own mechanism: `adoptStrandedHostPartitionSession` never deletes a declined row —
 * it leaves it in the host partition slice, and `partitionRowsTheWriteWontReturn` parks every
 * row this read declined to adopt into `contestedHostWorkspaceSessions[hostId]`, which
 * `attachHostSessionShadow` re-attaches into the SAME host's write-side slice on the next write —
 * but ONLY if that host already has a slice in the write (i.e. something else this boot routes
 * there). Whether a wake-triggered write actually resurrects a declined tab therefore depends on
 * whether anything else makes `persistWorkspaceSessionByHost`/`patchWorkspaceSessionByHost` touch
 * that specific host partition at all in the same call.
 *
 * Verdict, resolved: write-race protection is provided by `shadowRowsTheHostHasNotAnswered`
 * (`workspace-session-host-shadow-testimony.ts`), which withholds parked rows from the write-side
 * shadow once the host has answered for that target (positive testimony via landed, non-conflicting
 * remote-workspace hydration). While the host has NOT answered, preserving parked rows remains the
 * only safe move — this file stands guard against re-introducing the reverted naive drop that
 * unconditionally dropped parked rows without positive host testimony and caused unrecoverable data
 * loss on Concurrent Active Edits.
 */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'
import {
  persistWorkspaceSessionByHost,
  type HostPersistenceState
} from './workspace-session-host-persistence'

const TARGET_ID = 'target-1'
const SSH_HOST_ID: ExecutionHostId = `ssh:${TARGET_ID}`
const REPO_ID = 'repo-remote'
const WORKTREE_ID = `${REPO_ID}::/remote/checkout`
const SIBLING_REPO_ID = `${REPO_ID}-2`
const SIBLING_WORKTREE_ID = `${SIBLING_REPO_ID}::/remote/sibling`

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function partitionedApi(partitions: Partial<Record<string, WorkspaceSessionState>>) {
  return {
    get: async (hostId?: ExecutionHostId) =>
      partitions[hostId ?? 'local'] ?? getDefaultWorkspaceSession(),
    listHostIds: async () =>
      Object.keys(partitions).flatMap((hostId) => normalizeExecutionHostId(hostId) ?? [])
  }
}

function capturingApi() {
  const captured: Partial<Record<string, WorkspaceSessionState>> = {}
  return {
    captured,
    api: {
      get: async () => getDefaultWorkspaceSession(),
      patch: async () => {},
      setSync: () => {},
      set: async (payload: WorkspaceSessionState, hostId?: ExecutionHostId) => {
        captured[hostId ?? 'local'] = payload
      },
      flush: async () => {}
    }
  }
}

describe('GAP-03 Write Race Protection', () => {
  it('a wake-triggered write for a worktree with nothing else on the same host never even touches that host partition, so the declined tabs cannot round-trip back', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-2', WORKTREE_ID), tab('tab-3', WORKTREE_ID)]
          }
        })
      }),
      [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }]
    )
    expect(read.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])

    const { captured, api } = capturingApi()
    const state: HostPersistenceState = {
      repos: [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }],
      worktreesByRepo: {
        [REPO_ID]: [
          {
            id: WORKTREE_ID,
            repoId: REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ]
      },
      contestedHostWorkspaceSessions: read.contestedHostWorkspaceSessions,
      contestedPrimaryHostBySessionKey: read.contestedPrimaryHostBySessionKey
    }

    await persistWorkspaceSessionByHost(api as never, read.session, state)

    expect(captured[SSH_HOST_ID]).toBeUndefined()
  })

  it('still routes a declined row back into the host partition while the host has not answered for that target — preserving is the only safe move when nothing has superseded the parked verdict', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-2', WORKTREE_ID), tab('tab-3', WORKTREE_ID)],
            [SIBLING_WORKTREE_ID]: [tab('tab-4', SIBLING_WORKTREE_ID)]
          }
        })
      }),
      [
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID },
        { id: SIBLING_REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ]
    )
    // Read-time behavior is correct: WORKTREE_ID declined, SIBLING_WORKTREE_ID also parked (the
    // documented "Concurrent Active Edits" boundary — see workspace-session-host-offline-reconnect.test.ts).
    expect(read.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    expect(read.session.tabsByWorktree[SIBLING_WORKTREE_ID]).toBeUndefined()

    // Now simulate the SAME host legitimately gaining a write target this boot: the user opens a
    // brand-new local tab that main's own routing places on this SSH host (e.g. a fresh worktree
    // the user just created there). This is enough to force a slice for SSH_HOST_ID to exist on
    // the very next wake-triggered write.
    const NEW_LOCAL_WORKTREE_ID = `${SIBLING_REPO_ID}::/remote/new-tab`
    const payloadWithFreshLocalActivity: WorkspaceSessionState = {
      ...read.session,
      tabsByWorktree: {
        ...read.session.tabsByWorktree,
        [NEW_LOCAL_WORKTREE_ID]: [tab('tab-fresh', NEW_LOCAL_WORKTREE_ID)]
      }
    }

    const { captured, api } = capturingApi()
    const state: HostPersistenceState = {
      repos: [
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID },
        { id: SIBLING_REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ],
      worktreesByRepo: {
        [REPO_ID]: [
          {
            id: WORKTREE_ID,
            repoId: REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ],
        [SIBLING_REPO_ID]: [
          {
            id: NEW_LOCAL_WORKTREE_ID,
            repoId: SIBLING_REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ]
      },
      contestedHostWorkspaceSessions: read.contestedHostWorkspaceSessions,
      contestedPrimaryHostBySessionKey: read.contestedPrimaryHostBySessionKey
    }

    await persistWorkspaceSessionByHost(api as never, payloadWithFreshLocalActivity, state)

    // The write race, demonstrated: WORKTREE_ID's genuinely-closed tabs come back, even though the
    // read that produced this exact payload correctly declined them moments earlier.
    expect(captured[SSH_HOST_ID]?.tabsByWorktree?.[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-2',
      'tab-3'
    ])
  })

  it('stops routing a declined row back into the host partition once the host has answered for that target', async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-2', WORKTREE_ID), tab('tab-3', WORKTREE_ID)],
            [SIBLING_WORKTREE_ID]: [tab('tab-4', SIBLING_WORKTREE_ID)]
          }
        })
      }),
      [
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID },
        { id: SIBLING_REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ]
    )
    expect(read.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    expect(read.session.tabsByWorktree[SIBLING_WORKTREE_ID]).toBeUndefined()

    const NEW_LOCAL_WORKTREE_ID = `${SIBLING_REPO_ID}::/remote/new-tab`
    const payloadWithFreshLocalActivity: WorkspaceSessionState = {
      ...read.session,
      tabsByWorktree: {
        ...read.session.tabsByWorktree,
        [NEW_LOCAL_WORKTREE_ID]: [tab('tab-fresh', NEW_LOCAL_WORKTREE_ID)]
      }
    }

    const { captured, api } = capturingApi()
    const state: HostPersistenceState = {
      repos: [
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID },
        { id: SIBLING_REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ],
      worktreesByRepo: {
        [REPO_ID]: [
          {
            id: WORKTREE_ID,
            repoId: REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ],
        [SIBLING_REPO_ID]: [
          {
            id: NEW_LOCAL_WORKTREE_ID,
            repoId: SIBLING_REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ]
      },
      contestedHostWorkspaceSessions: read.contestedHostWorkspaceSessions,
      contestedPrimaryHostBySessionKey: read.contestedPrimaryHostBySessionKey,
      remoteWorkspaceHydratedTargetIds: new Set([TARGET_ID]),
      remoteWorkspaceSyncStatusByTargetId: { [TARGET_ID]: { phase: 'synced' } }
    }

    await persistWorkspaceSessionByHost(api as never, payloadWithFreshLocalActivity, state)

    expect(captured[SSH_HOST_ID]?.tabsByWorktree?.[WORKTREE_ID]).toBeUndefined()
    expect(captured[SSH_HOST_ID]?.tabsByWorktree?.[SIBLING_WORKTREE_ID]).toBeUndefined()
    expect(
      captured[SSH_HOST_ID]?.tabsByWorktree?.[NEW_LOCAL_WORKTREE_ID]?.map((e) => e.id)
    ).toEqual(['tab-fresh'])
  })

  it('a deferred write prepared before testimony arrived does not overwrite authoritative state if testimony arrives before delivery', async () => {
    // CodeRabbit finding 3: an api.set call generated while hostHasAnsweredForTarget was false
    // (so declined tabs were attached by the shadow) can be delivered AFTER the live snapshot lands
    // and testimony flips true. If nothing orders in-flight writes against the live snapshot's
    // arrival, the stale in-flight payload overwrites the authoritative state and resurrects the
    // closed tabs.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-2', WORKTREE_ID), tab('tab-3', WORKTREE_ID)],
            [SIBLING_WORKTREE_ID]: [tab('tab-4', SIBLING_WORKTREE_ID)]
          }
        })
      }),
      [
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID },
        { id: SIBLING_REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ]
    )
    expect(read.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])

    const NEW_LOCAL_WORKTREE_ID = `${SIBLING_REPO_ID}::/remote/new-tab`
    const payloadWithFreshLocalActivity: WorkspaceSessionState = {
      ...read.session,
      tabsByWorktree: {
        ...read.session.tabsByWorktree,
        [NEW_LOCAL_WORKTREE_ID]: [tab('tab-fresh', NEW_LOCAL_WORKTREE_ID)]
      }
    }

    const state: HostPersistenceState = {
      repos: [
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID },
        { id: SIBLING_REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ],
      worktreesByRepo: {
        [REPO_ID]: [
          {
            id: WORKTREE_ID,
            repoId: REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ],
        [SIBLING_REPO_ID]: [
          {
            id: NEW_LOCAL_WORKTREE_ID,
            repoId: SIBLING_REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ]
      },
      contestedHostWorkspaceSessions: read.contestedHostWorkspaceSessions,
      contestedPrimaryHostBySessionKey: read.contestedPrimaryHostBySessionKey,
      remoteWorkspaceHydratedTargetIds: new Set<string>(),
      remoteWorkspaceSyncStatusByTargetId: {}
    }

    const captured: Partial<Record<string, WorkspaceSessionState>> = {}
    const api = {
      get: async () => getDefaultWorkspaceSession(),
      patch: async () => {},
      setSync: () => {},
      set: async (payload: WorkspaceSessionState, hostId?: ExecutionHostId) => {
        captured[hostId ?? 'local'] = payload
      },
      flush: async () => {}
    }

    // An earlier write W0 is in-flight on SSH_HOST_ID, holding that partition's write queue:
    let releaseW0!: () => void
    const w0Gate = new Promise<void>((resolve) => {
      releaseW0 = resolve
    })
    const w0Promise = persistWorkspaceSessionByHost(
      {
        ...api,
        set: async (_payload: WorkspaceSessionState, hostId?: ExecutionHostId) => {
          if (hostId === SSH_HOST_ID) {
            await w0Gate
          }
        }
      } as never,
      session({
        tabsByWorktree: {
          [NEW_LOCAL_WORKTREE_ID]: [tab('tab-fresh', NEW_LOCAL_WORKTREE_ID)]
        }
      }),
      state
    )

    // W1 is dispatched while W0 is in-flight: W1 carries the stale declined tabs (prepared without testimony)
    // and queues behind W0 on SSH_HOST_ID.
    const writePromise = persistWorkspaceSessionByHost(
      api as never,
      payloadWithFreshLocalActivity,
      state
    )

    // While W1 is in-flight / queued, the live snapshot lands on the partition and establishes authoritative state:
    captured[SSH_HOST_ID] = session({
      tabsByWorktree: {
        [SIBLING_WORKTREE_ID]: [tab('tab-4', SIBLING_WORKTREE_ID)]
      }
    })
    // And testimony arrives:
    state.remoteWorkspaceHydratedTargetIds = new Set([TARGET_ID])
    state.remoteWorkspaceSyncStatusByTargetId = { [TARGET_ID]: { phase: 'synced' } }

    // Release W0 to let the queue proceed:
    releaseW0()
    await w0Promise
    await writePromise

    // W1 was queued behind W0 and prepared before testimony arrived; when W1 dequeued,
    // it observed that testimony had landed for TARGET_ID, so it discarded its stale pre-testimony
    // payload rather than overwriting the authoritative state!
    expect(captured[SSH_HOST_ID]?.tabsByWorktree?.[WORKTREE_ID]).toBeUndefined()
    expect(captured[SSH_HOST_ID]?.tabsByWorktree?.[SIBLING_WORKTREE_ID]?.map((e) => e.id)).toEqual([
      'tab-4'
    ])
  })
})

describe('GAP-03 regression: a declined tab must park and restore its dependent tab/pane rows too', () => {
  it('carries terminalLayoutsByTabId and remoteSessionIdsByTabId for a declined tab back with it, not just tabsByWorktree', async () => {
    // Same shape as the "still routes a declined row back" case above (host has not answered yet,
    // so preserving the parked verdict is the only safe move), but this host partition also carries
    // per-tab rows for the declined worktree's tabs: a terminal layout and a remote relay session id.
    // `partitionRowsTheWriteWontReturn` only walked `worktreeKeyed` fields, so these tab-keyed rows
    // were never parked -- and the next write to this SSH partition (forced here by the sibling
    // worktree's fresh local activity, same as the sibling test above) drops them even though the
    // worktree-keyed `tabsByWorktree` row for the same declined tabs correctly comes back.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-2', WORKTREE_ID), tab('tab-3', WORKTREE_ID)],
            [SIBLING_WORKTREE_ID]: [tab('tab-4', SIBLING_WORKTREE_ID)]
          },
          terminalLayoutsByTabId: {
            'tab-2': { root: null, activeLeafId: null, expandedLeafId: null } as never
          },
          remoteSessionIdsByTabId: {
            'tab-2': 'ssh:target-1@@pty-2'
          }
        })
      }),
      [
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID },
        { id: SIBLING_REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ]
    )
    expect(read.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])

    const NEW_LOCAL_WORKTREE_ID = `${SIBLING_REPO_ID}::/remote/new-tab`
    const payloadWithFreshLocalActivity: WorkspaceSessionState = {
      ...read.session,
      tabsByWorktree: {
        ...read.session.tabsByWorktree,
        [NEW_LOCAL_WORKTREE_ID]: [tab('tab-fresh', NEW_LOCAL_WORKTREE_ID)]
      }
    }

    const { captured, api } = capturingApi()
    const state: HostPersistenceState = {
      repos: [
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID },
        { id: SIBLING_REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ],
      worktreesByRepo: {
        [REPO_ID]: [
          {
            id: WORKTREE_ID,
            repoId: REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ],
        [SIBLING_REPO_ID]: [
          {
            id: NEW_LOCAL_WORKTREE_ID,
            repoId: SIBLING_REPO_ID,
            hostId: SSH_HOST_ID,
            runtimeOwnerEnvironmentId: undefined
          }
        ]
      },
      contestedHostWorkspaceSessions: read.contestedHostWorkspaceSessions,
      contestedPrimaryHostBySessionKey: read.contestedPrimaryHostBySessionKey
    }

    await persistWorkspaceSessionByHost(api as never, payloadWithFreshLocalActivity, state)

    // The worktree-keyed row already round-trips correctly (pinned by the sibling test above).
    expect(captured[SSH_HOST_ID]?.tabsByWorktree?.[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-2',
      'tab-3'
    ])
    // The tab-keyed rows for the SAME declined tab must survive the write alongside it.
    expect(captured[SSH_HOST_ID]?.terminalLayoutsByTabId?.['tab-2']).toBeDefined()
    expect(captured[SSH_HOST_ID]?.remoteSessionIdsByTabId?.['tab-2']).toBe('ssh:target-1@@pty-2')
  })
})
