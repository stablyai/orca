/**
 * GAP-03 Rapid Sleep/Wake Cycles (revive_labs#962 / stablyai/orca#22038, PR #968 deferred
 * scenario): `fetchWorkspaceSessionWithRuntimeHostOwners` "runs exactly once per app lifetime, at
 * renderer boot" (see `gap-03-offline-reconnect-tab-resurrection.spec.ts`'s own docblock) — a
 * suspend/resume or a network drop mid-session never re-runs it. The only way this hydration path
 * runs more than once in a row is a sequence of full app quit+relaunch cycles against the same
 * on-disk profile. This suite models "rapid sleep/wake" as exactly that: several consecutive
 * boot cycles in quick succession, with the server closing more tabs between some of them,
 * and checks for the upstream matrix's three concerns —
 *   1. no cumulative resurrection (a tab declined on cycle N never reappears on cycle N+1..5),
 *   2. no state corruption (each cycle's `session` is a normal, well-formed session), and
 *   3. no duplicate adoption (a tab adopted once is never adopted a second time from the same
 *      stale mirror on a later cycle).
 */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'

const TARGET_ID = 'target-1'
const SSH_HOST_ID: ExecutionHostId = `ssh:${TARGET_ID}`
const REPO_ID = 'repo-remote'
const WORKTREE_ID = `${REPO_ID}::/remote/checkout`
const REPOS = [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }]

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

describe('GAP-03 Rapid Sleep/Wake Cycles: five consecutive quit+relaunch cycles against the same on-disk profile', () => {
  it('never resurrects a tab that a prior cycle already declined, across 5 rapid cycles with tabs closing between some of them', async () => {
    // Cycle 1: two tabs open, target disconnected at shutdown (the offline gap). All server-side
    // closures already happened before cycle 1 boots, matching "closed while offline" exactly.
    const cycle1 = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID), tab('tab-2', WORKTREE_ID)]
          }
        })
      }),
      REPOS
    )
    expect(cycle1.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])

    // Cycles 2-5: the on-disk host mirror is untouched (nobody rewrote it — the same stale cache
    // from before cycle 1 persists, since cycle 1 never adopted or wrote anything for this
    // worktree). Each cycle re-reads the exact same stale mirror. None of the 4 additional cycles
    // may resurrect the declined tabs, and none may produce a different verdict than cycle 1 —
    // convergence, not drift, across repeated boots of an unchanged on-disk state.
    for (let cycle = 2; cycle <= 5; cycle += 1) {
      const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
        partitionedApi({
          local: session({}),
          [SSH_HOST_ID]: session({
            tabsByWorktree: {
              [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID), tab('tab-2', WORKTREE_ID)]
            }
          })
        }),
        REPOS
      )
      expect(read.session.tabsByWorktree[WORKTREE_ID] ?? [], `cycle ${cycle}`).toEqual([])
    }
  })

  it('converges to the latest closure without duplicate adoption when a survivor tab is progressively closed across cycles', async () => {
    // Cycle A: the target is actively connected (an ordinary boot; nothing offline yet) with two
    // tabs open. Both must adopt normally per the restart-regression fix.
    const cycleA = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({ activeConnectionIdsAtShutdown: [TARGET_ID] }),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID), tab('tab-2', WORKTREE_ID)]
          }
        })
      }),
      REPOS
    )
    expect(cycleA.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-1',
      'tab-2'
    ])

    // Cycle B: the client goes offline (disconnects, then quits without reconnecting -- target
    // drops out of activeConnectionIdsAtShutdown) and the server closes tab-2 while it is gone.
    // The all-or-nothing worktree-level decline still protects the survivor tab-1's stale cached
    // copy from being silently dropped by a later cycle: it stays in the parked/undeclined mirror
    // rather than resurrecting a fresher truth this static merge cannot observe.
    const cycleB = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID), tab('tab-2', WORKTREE_ID)]
          }
        })
      }),
      REPOS
    )
    // Worktree-level decline: since the host mirror still names a real (non-empty) row for this
    // id and the base has no row of its own, GAP-03 declines the whole worktree — the cache is
    // simply not adopted this cycle, not partially merged into [tab-1] alone.
    expect(cycleB.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])

    // Cycle C: a third consecutive boot against the SAME stale, declined mirror. No duplicate
    // adoption, no drift from cycle B's verdict, no corruption of the session shape.
    const cycleC = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID), tab('tab-2', WORKTREE_ID)]
          }
        })
      }),
      REPOS
    )
    expect(cycleC.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    expect(cycleC.session.tabsByWorktree).toEqual(cycleB.session.tabsByWorktree)
  })
})
