/**
 * GAP-03: offline paired clients retain stale tabs in their cached host partition and re-inject
 * them into the merged session on reconnect.
 *
 * `adoptStrandedHostPartitionSession` (src/shared/workspace-session-stranded-partition-adoption.ts)
 * treats a `base` worktree as "owned" — and therefore protected from adoption — only when it holds
 * a NON-EMPTY `tabsByWorktree` row (`workspacesTheBaseOwns`). When every tab for a worktree has
 * been closed server-side while a client was disconnected, the base's row for that worktree goes
 * to empty/absent, so it is no longer "owned". The stranded/cached host partition — the client's
 * stale on-disk mirror of a runtime/ssh host session from before it went offline — still carries
 * the closed tabs, and `adoptStrandedHostPartitionSession` unconditionally folds them back into the
 * merged session, re-injecting tabs the user (or another client) explicitly closed while this
 * client was away. That merged session is then the payload the next
 * `persistWorkspaceSessionByHost`/`patchWorkspaceSessionByHost` call round-trips back to the host
 * partition and broadcasts to every other connected client — the "ghost tab" resurrection reported
 * in revive_labs#962 and filed upstream as stablyai/orca#22038.
 *
 * Contrast with the sibling `workspace-session-ssh-partition-ownership.test.ts` suite: those tests
 * pin the #12721 protection (an empty PARTITION row is not proof of absence, and a base's own
 * unsaved draft must survive when the OTHER side is empty). This suite pins the opposite gap: an
 * empty BASE row is treated as "nothing to protect", so a stale but non-empty host row wins even
 * though it names tabs the base has no record of intentionally reopening.
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

/** A session read whose partitions are exactly what persistence holds, plus its census. */
function partitionedApi(partitions: Partial<Record<string, WorkspaceSessionState>>) {
  return {
    get: async (hostId?: ExecutionHostId) =>
      partitions[hostId ?? 'local'] ?? getDefaultWorkspaceSession(),
    listHostIds: async () =>
      Object.keys(partitions).flatMap((hostId) => normalizeExecutionHostId(hostId) ?? [])
  }
}

describe('GAP-03: offline client reconnect must not resurrect server-closed tabs', () => {
  it('does not re-adopt a tab that was closed on the host while this client was offline', async () => {
    // The client's LOCAL read reflects current truth: the worktree's tabs were all closed while
    // this client was disconnected, so its `tabsByWorktree` row is now empty/absent.
    // The `ssh:<targetId>` partition is this client's STALE on-disk cache from before it went
    // offline: it still names the two now-closed tabs.
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

    // Expected: reconnect purges the stale cached tabs instead of reinjecting them into the
    // merged session (and, downstream, back into the host partition and every other client).
    expect(read.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
  })
})

describe('GAP-03 regression: canonical-keyed host rows must still be declined', () => {
  it('declines a stale tab row even when the host partition stores it under a canonical `worktree:` key', async () => {
    // The host partition's `tabsByWorktree` type comment says keys "may be legacy raw worktree IDs
    // or canonical WorkspaceKey values" (`worktree:${worktreeId}`). The decline loop in
    // `adoptStrandedHostPartitionSession` (workspace-session-stranded-partition-adoption.ts) reads
    // `host.tabsByWorktree[workspaceId]` with the bare id, so a host row keyed canonically is
    // invisible to it -- the row silently defeats the whole decline and its stale tabs get adopted.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [`worktree:${WORKTREE_ID}`]: [tab('tab-2', WORKTREE_ID), tab('tab-3', WORKTREE_ID)]
          }
        })
      }),
      [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }]
    )

    const survivingTabIds = Object.entries(read.session.tabsByWorktree ?? {})
      .flatMap(([, tabs]) => tabs)
      .map((entry) => entry.id)
    expect(survivingTabIds).toEqual([])
  })
})

describe('GAP-03 regression: unknown shutdown status must not decline tabs if remoteSessionIdsByTabId indicates connection', () => {
  it('keeps tabs when activeConnectionIdsAtShutdown is undefined but remoteSessionIdsByTabId names the target', async () => {
    // When activeConnectionIdsAtShutdown is undefined (older persisted sessions, interrupted
    // shutdowns), treating it as an empty set passes false ("disconnected") into
    // reconciledWorktreeIdsForHost, which then declines every worktree on that host -- dropping
    // tabs that were actually connected. If remoteSessionIdsByTabId still holds a session for the
    // target, connection status must be inferred as connected so tabs survive.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({
          remoteSessionIdsByTabId: { 'tab-1': `ssh:${TARGET_ID}@@pty-1` }
        }),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID), tab('tab-2', WORKTREE_ID)]
          }
        })
      }),
      [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }]
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-1',
      'tab-2'
    ])
  })
})

describe('GAP-03 non-regression: #12721 offline-created local work must survive reconnect', () => {
  it('keeps a genuinely offline-created tab that was never synced to the host partition', async () => {
    // This client created a tab entirely offline — the host partition (mirroring the last state
    // synced from the server before disconnect) has nothing for this worktree at all, because the
    // tab never existed server-side. `hostHasNothingFor` / the empty-host-row rule from #12721 is
    // exactly what must keep protecting this: an empty host row is never adopted, so it cannot
    // out-rank the base's real, populated row.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-offline-draft', WORKTREE_ID)] }
        }),
        [SSH_HOST_ID]: session({})
      }),
      [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }]
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-offline-draft'
    ])
  })
})

describe('GAP-03 regression: an ordinary restart must not be treated as an offline reconnect', () => {
  it('keeps every still-open tab when the SSH target was still connected at the last shutdown', async () => {
    // `remote-repo-registration.ts` stamps `executionHostId` on every SSH repo it registers (the
    // modern, default shape -- not a rare legacy one), so `confirmedSessionKeysByHostId` fires for
    // this repo exactly as it would in real usage. Before the `activeConnectionIdsAtShutdown` gate
    // was added, `reconciledWorktreeIdsForHost` applied unconditionally: since an SSH worktree's
    // `tabsByWorktree` row NEVER routes to `local` in the first place (`buildHostSessionRouting`
    // always sends it to `ssh:<targetId>`), `base.tabsByWorktree[WORKTREE_ID]` is absent on EVERY
    // boot, closed or not -- so this exact "two still-open tabs, ordinary quit + relaunch, nothing
    // closed by anyone" case was declined and dropped on every single restart of every SSH
    // worktree whose repo carries the modern stamp. `activeConnectionIdsAtShutdown` is the same
    // field `use-app-startup-hydration.ts` reads to decide which SSH targets to auto-reconnect at
    // boot, so "this target was connected at last shutdown" is an existing, meaningful signal
    // that the host partition's mirror is this client's OWN current state, not a stale pre-offline
    // cache -- and the one case GAP-03 was never meant to touch at all.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({ activeConnectionIdsAtShutdown: [TARGET_ID] }),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID), tab('tab-2', WORKTREE_ID)]
          }
        })
      }),
      [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }]
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-1',
      'tab-2'
    ])
  })

  it('still declines a worktree whose tabs were genuinely closed while the target was disconnected at shutdown', async () => {
    // Same confirmed-attribution shape as the regression above, but the target was NOT connected
    // at last shutdown -- the actual GAP-03 precondition -- so the decline must still fire.
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
  })
})

describe('GAP-03 Split Layout Pruning: a declined worktree carries no orphaned split-layout leaves', () => {
  it('excludes tabGroupLayouts/tabGroups/unifiedTabs for a declined worktree exactly like tabsByWorktree, so no dead-leaf layout survives to be hydrated', async () => {
    const SPLIT_GROUP_LEFT = 'group-left'
    const SPLIT_GROUP_RIGHT = 'group-right'
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({}),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-2', WORKTREE_ID), tab('tab-3', WORKTREE_ID)]
          },
          unifiedTabs: {
            [WORKTREE_ID]: [
              {
                id: 'tab-2',
                entityId: 'tab-2',
                groupId: SPLIT_GROUP_LEFT,
                worktreeId: WORKTREE_ID,
                contentType: 'terminal',
                label: 'tab-2',
                customLabel: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              },
              {
                id: 'tab-3',
                entityId: 'tab-3',
                groupId: SPLIT_GROUP_RIGHT,
                worktreeId: WORKTREE_ID,
                contentType: 'terminal',
                label: 'tab-3',
                customLabel: null,
                color: null,
                sortOrder: 1,
                createdAt: 1
              }
            ]
          },
          tabGroups: {
            [WORKTREE_ID]: [
              {
                id: SPLIT_GROUP_LEFT,
                worktreeId: WORKTREE_ID,
                activeTabId: 'tab-2',
                tabOrder: ['tab-2']
              },
              {
                id: SPLIT_GROUP_RIGHT,
                worktreeId: WORKTREE_ID,
                activeTabId: 'tab-3',
                tabOrder: ['tab-3']
              }
            ]
          },
          tabGroupLayouts: {
            [WORKTREE_ID]: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', groupId: SPLIT_GROUP_LEFT },
              second: { type: 'leaf', groupId: SPLIT_GROUP_RIGHT }
            }
          }
        })
      }),
      [{ id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }]
    )

    // The decline is per-worktree across every field, not per-tab: a worktree that is declined
    // carries no rows in ANY of these fields, so there is no stale split node left over to prune.
    expect(read.session.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    expect(read.session.unifiedTabs?.[WORKTREE_ID]).toBeUndefined()
    expect(read.session.tabGroups?.[WORKTREE_ID]).toBeUndefined()
    expect(read.session.tabGroupLayouts?.[WORKTREE_ID]).toBeUndefined()
  })
})

describe('GAP-03 Concurrent Active Edits', () => {
  it('achievable case: a live sibling worktree on the same confirmed host adopts normally when the host was NOT disconnected', async () => {
    // Maps "Client A opens Tab-4 on another worktree while Client B is online" onto this
    // architecture: B's own connection to the shared SSH target was never interrupted (still
    // listed in `activeConnectionIdsAtShutdown`), so BOTH this worktree's own survivor tab and a
    // second, previously-unseen worktree's freshly-opened tab on the SAME host must adopt --
    // reconciliation is skipped for the whole host, exactly like the plain-restart regression
    // above, because nothing about this boot represents an offline gap at all.
    const SIBLING_WORKTREE_ID = `${REPO_ID}-2::/remote/sibling`
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({ activeConnectionIdsAtShutdown: [TARGET_ID] }),
        [SSH_HOST_ID]: session({
          tabsByWorktree: {
            [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID)],
            [SIBLING_WORKTREE_ID]: [tab('tab-4', SIBLING_WORKTREE_ID)]
          }
        })
      }),
      [
        { id: REPO_ID, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID },
        { id: `${REPO_ID}-2`, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ]
    )

    expect(read.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['tab-1'])
    expect(read.session.tabsByWorktree[SIBLING_WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-4'
    ])
  })

  it('documented boundary: a genuinely offline reconnect parks (never deletes) a live sibling worktree it cannot yet distinguish from a closed one', async () => {
    // The harder case the upstream matrix describes -- Client A opens a brand-new worktree's
    // first tab while Client B is genuinely OFFLINE (disconnected at last shutdown, the real
    // GAP-03 precondition) -- is NOT solvable by this fix's design. `reconciledWorktreeIdsForHost`
    // gates per HOST, not per worktree: once a host is treated as "possibly stale" (disconnected
    // at shutdown), a worktree the base has never cached at all is indistinguishable from one
    // whose tabs were genuinely closed while offline -- both look identical on disk (absent base
    // row, non-empty host mirror). Resolving this would need a live signal from the server (an
    // authoritative manifest/handshake, e.g. the upstream draft's own `manifestEpoch` proposal) --
    // there is no such signal in this fix. The behavior below is the SAFE fallback: the sibling's
    // row is parked in the write-side shadow (survives, recoverable by a live SSH reconnect later)
    // rather than deleted, but it is NOT adopted into the visible session on this boot.
    const SIBLING_WORKTREE_ID = `${REPO_ID}-2::/remote/sibling`
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
        { id: `${REPO_ID}-2`, connectionId: TARGET_ID, executionHostId: SSH_HOST_ID }
      ]
    )

    // Not adopted this boot -- the known, accepted limitation.
    expect(read.session.tabsByWorktree[SIBLING_WORKTREE_ID]).toBeUndefined()
    // But not deleted either: it survives in the write-side shadow for the host partition, so a
    // live SSH reconnect (a separate code path this fix does not touch) can still recover it, and
    // writes before host testimony arrives cannot erase it (`attachHostSessionShadow`). Once the
    // host answers with a live non-conflicting snapshot, testimony supersedes terminal rows, while
    // non-terminal state (like editor drafts) remains protected.
    expect(
      read.contestedHostWorkspaceSessions[SSH_HOST_ID]?.tabsByWorktree?.[SIBLING_WORKTREE_ID]?.map(
        (entry: TerminalTab) => entry.id
      )
    ).toEqual(['tab-4'])
  })
})
