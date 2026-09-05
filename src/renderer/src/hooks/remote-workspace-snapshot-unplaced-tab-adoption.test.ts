/**
 * STA-3593: a fresh client adopts 0 of the host's 3 terminal tabs, then calls that answer final.
 *
 * The chain, all of it already load-bearing today: preparation's lineage read comes back
 * `degraded` (the `DIRECT_SSH_HOST_READ_TIMEOUT_MS` deadline fired, or the listing was not
 * authoritative), so `mergeExactHostLineage` never ran and `worktreesByRepo` /
 * `detectedWorktreesByRepo` hold nothing for that host. A token is still issued on purpose — the
 * terminals must still reconnect — so the pull proceeds, `exactTargetWorktreeIds` derives an empty
 * set from the empty catalog, `uniqueWorktreeIdByPath` answers null for every host path, and the
 * projection drops every host tab row. The snapshot apply then marks the target hydrated and the
 * phase `'synced'`, promoting "we could not place these yet" to "the host has nothing".
 *
 * The oracle is the promotion, not the drop. Without a local catalog there is nowhere to put the
 * rows, and that is fine and recoverable — what is not recoverable is declaring the empty result
 * authoritative. An unplaceable row is `unverifiable`, never `exited`
 * (docs/reference/ssh-execution-boundary.md). Getting back to a placed picture is the caller's job:
 * this apply has no way back once its bounded wait expires, so it reports the paths it dropped and
 * remote-workspace-target-sync.ts re-pulls when the catalog can place them.
 *
 * The catalog-present case is pinned alongside it so the gate cannot be satisfied by never
 * hydrating anything.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RemoteWorkspaceObservedSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import { applyDirectSshRemoteWorkspaceSnapshot } from './remote-workspace-snapshot-apply'
import { resolveWorkspaceTerminalHostAuthority } from '../lib/workspace-terminal-host-authority'
import type { DirectSshSnapshotApplyToken } from './direct-ssh-reconnect-coordinator-types'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const TARGET_ID = 'ssh-target-1'
const REPO_ROOT = '/srv/proj'
const ALPHA = `${REPO_ROOT}/alpha`
const BETA = `${REPO_ROOT}/beta`
const ALPHA_ID = `repoA::${ALPHA}`
const BETA_ID = `repoA::${BETA}`

const authority: DirectSshAuthority = {
  targetId: TARGET_ID,
  providerEpoch: 'provider-epoch-1' as SshProviderEpoch,
  connectionGeneration: 1
}

/** `degraded` is what preparation stamps when the lineage read missed its deadline. */
function token(snapshotRevision: number): DirectSshSnapshotApplyToken {
  return {
    authority,
    catalogRevision: 0,
    repoFingerprint: 'fp',
    authorityRequirement: 'required',
    snapshotRevision,
    outcome: 'degraded'
  }
}

function tabRow(worktreePath: string, tabId: string, sortOrder: number) {
  return {
    id: tabId,
    worktreePath,
    ptyId: `pty-${tabId}`,
    title: tabId,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

/** Three host terminals spread over two host workspaces. */
function snapshot(revision: number): RemoteWorkspaceObservedSnapshot {
  const tabsByWorktreePath = {
    [ALPHA]: [tabRow(ALPHA, 'T1', 0), tabRow(ALPHA, 'T2', 1)],
    [BETA]: [tabRow(BETA, 'T3', 0)]
  }
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    hostObservationToken: `observation-${revision}`,
    session: {
      activeWorktreePath: ALPHA,
      activeTabId: 'T1',
      tabsByWorktreePath,
      terminalLayoutsByTabId: {},
      activeWorktreePathsOnShutdown: [],
      activeTabIdByWorktreePath: { [ALPHA]: 'T1', [BETA]: 'T3' },
      remoteSessionIdsByTabId: { T1: 'pty-T1', T2: 'pty-T2', T3: 'pty-T3' },
      lastVisitedAtByWorktreePath: { [ALPHA]: revision, [BETA]: revision },
      defaultTerminalTabsAppliedByWorktreePath: { [ALPHA]: true, [BETA]: true }
    }
  } satisfies RemoteWorkspaceObservedSnapshot
}

/** Same shape as the snapshot above, minus the terminal rows. */
function emptySnapshot(revision: number): RemoteWorkspaceObservedSnapshot {
  const base = snapshot(revision)
  return {
    ...base,
    session: {
      ...base.session,
      activeTabId: null,
      tabsByWorktreePath: { [ALPHA]: [], [BETA]: [] },
      activeTabIdByWorktreePath: { [ALPHA]: null, [BETA]: null },
      remoteSessionIdsByTabId: {}
    }
  }
}

type TestStore = ReturnType<typeof createTestStore>

function createStore(): TestStore {
  const store = createTestStore()
  store.setState({
    repos: [
      {
        id: 'repoA',
        path: REPO_ROOT,
        displayName: 'Proj',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: TARGET_ID
      } as never
    ],
    // Only the IPC-backed reconnect is stubbed. Hydration bookkeeping and sync status stay real —
    // they are the signals under test.
    reconnectPersistedTerminals: (async () => {}) as never
  })
  return store
}

/** What `mergeExactHostLineage` would have written had the lineage read landed. */
function landHostLineage(store: TestStore): void {
  store.setState({
    worktreesByRepo: {
      repoA: [
        makeWorktree({
          id: ALPHA_ID,
          repoId: 'repoA',
          path: ALPHA,
          hostId: `ssh:${TARGET_ID}`
        } as never),
        makeWorktree({
          id: BETA_ID,
          repoId: 'repoA',
          path: BETA,
          hostId: `ssh:${TARGET_ID}`
        } as never)
      ]
    }
  })
}

function landAlphaLineage(store: TestStore): void {
  store.setState({
    worktreesByRepo: {
      repoA: [
        makeWorktree({
          id: ALPHA_ID,
          repoId: 'repoA',
          path: ALPHA,
          hostId: `ssh:${TARGET_ID}`
        } as never)
      ]
    }
  })
}

function addLocalTab(store: TestStore, tabId: string): void {
  const current = store.getState()
  store.setState({
    tabsByWorktree: {
      ...current.tabsByWorktree,
      [ALPHA_ID]: [
        ...(current.tabsByWorktree[ALPHA_ID] ?? []),
        {
          id: tabId,
          worktreeId: ALPHA_ID,
          ptyId: null,
          title: tabId,
          customTitle: null,
          color: null,
          sortOrder: 99,
          createdAt: Date.now()
        } as never
      ]
    }
  })
}

async function applySnapshot(
  store: TestStore,
  snap: RemoteWorkspaceObservedSnapshot
): Promise<void> {
  await applyDirectSshRemoteWorkspaceSnapshot({
    store,
    snapshot: snap,
    token: token(snap.revision),
    arrival: 1,
    isArrivalCurrent: () => true,
    isPreparationTokenCurrent: () => true,
    waitForWorkspaceSessionReady: async () => true,
    finalizeHydratedTerminals: () => 0
  })
}

function adoptedTabIds(store: TestStore): string[] {
  return Object.values(store.getState().tabsByWorktree)
    .flat()
    .map((tab) => tab.id)
    .sort()
}

function isHydrated(store: TestStore): boolean {
  return store.getState().remoteWorkspaceHydratedTargetIds.has(TARGET_ID)
}

function syncPhase(store: TestStore): string | undefined {
  return store.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]?.phase
}

describe('a host snapshot whose terminal tabs cannot be placed locally', () => {
  it('merges against state changed while an unplaced path waits and times out', async () => {
    vi.useFakeTimers()
    try {
      const store = createStore()
      // ALPHA is placeable, while BETA keeps the placement waiter open.
      landAlphaLineage(store)

      const pending = applyDirectSshRemoteWorkspaceSnapshot({
        store,
        snapshot: snapshot(100),
        token: token(100),
        arrival: 1,
        isArrivalCurrent: () => true,
        isPreparationTokenCurrent: () => true,
        waitForWorkspaceSessionReady: async () => true,
        finalizeHydratedTerminals: () => 0
      })
      await Promise.resolve()
      await Promise.resolve()
      addLocalTab(store, 'created-while-waiting')

      await vi.advanceTimersByTimeAsync(10_000)
      await pending

      expect(adoptedTabIds(store)).toContain('created-while-waiting')
      expect(store.getState().tabsByWorktree[ALPHA_ID]?.map((tab) => tab.id)).toEqual([
        'T1',
        'T2',
        'created-while-waiting'
      ])
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('does not call the empty result authoritative when the local catalog never landed', async () => {
    const store = createStore()
    // Degraded lineage: the catalog holds no worktree row for this host.
    expect(store.getState().worktreesByRepo).toEqual({})

    const snap = snapshot(1)
    expect(Object.values(snap.session.tabsByWorktreePath).flat()).toHaveLength(3)

    await applySnapshot(store, snap)

    // Nowhere to put them — recoverable on its own.
    expect(adoptedTabIds(store), 'no local worktree row exists to hang the host tabs on').toEqual(
      []
    )
    // Not recoverable: promoting that to truth. This apply never re-pulls on its own; the deferred
    // placement watch in remote-workspace-target-sync.ts is what re-pulls once the lineage lands.
    expect(
      isHydrated(store),
      'the host named 3 terminals and this client placed none of them, so the target is not hydrated'
    ).toBe(false)
    expect(
      syncPhase(store),
      'a pull that dropped every host tab row has not synced the workspace'
    ).not.toBe('synced')
  })

  it('revokes a hydration it granted earlier when a later snapshot cannot be placed', async () => {
    const store = createStore()
    landHostLineage(store)
    await applySnapshot(store, snapshot(1))
    expect(isHydrated(store)).toBe(true)

    // The lineage degrades on a later reconnect: the catalog rows this client had are gone.
    store.setState({ worktreesByRepo: {}, detectedWorktreesByRepo: {} })
    await applySnapshot(store, snapshot(2))

    // Why revoke rather than merely withhold: the hydrated set is add-only, and hydration is what
    // authorises uploads. A stale flag would keep uploading this incomplete picture, and an upload
    // wholesale replaces the host snapshot — deleting the tabs we just failed to place.
    expect(
      isHydrated(store),
      'a stale hydration still authorises a replace-session upload from an incomplete picture'
    ).toBe(false)
  })

  it('leaves terminal authority unverifiable, so nothing seeds or resumes over the host', async () => {
    const store = createStore()
    await applySnapshot(store, snapshot(1))

    // `offline`/`error` on an un-hydrated target are the authority resolver's bounded floor and
    // resolve to `none`, which authorises seeding AND sleeping-agent resume. An unplaced snapshot
    // must not land in that set: the host's tabs are live, we simply could not place them.
    expect(
      resolveWorkspaceTerminalHostAuthority(store.getState(), ALPHA_ID),
      'an unplaced snapshot authorised seeding over live host terminals'
    ).toBe('unverifiable')
  })

  it('adopts every host tab and declares the target hydrated once the catalog is present', async () => {
    const store = createStore()
    landHostLineage(store)

    await applySnapshot(store, snapshot(1))

    expect(adoptedTabIds(store)).toEqual(['T1', 'T2', 'T3'])
    expect(store.getState().tabsByWorktree[ALPHA_ID]?.map((tab) => tab.id)).toEqual(['T1', 'T2'])
    expect(store.getState().tabsByWorktree[BETA_ID]?.map((tab) => tab.id)).toEqual(['T3'])
    expect(isHydrated(store)).toBe(true)
    expect(syncPhase(store)).toBe('synced')
  })

  it('recovers on the next snapshot once the catalog lands', async () => {
    const store = createStore()

    // First pass: the lineage read was degraded, so nothing places and the target is left
    // un-hydrated on purpose. A later snapshot is how this apply, on its own, gets back.
    await applySnapshot(store, snapshot(1))
    expect(adoptedTabIds(store)).toEqual([])
    expect(isHydrated(store)).toBe(false)

    // A later connect or host push arrives after the catalog landed.
    landHostLineage(store)
    await applySnapshot(store, snapshot(2))

    expect(
      adoptedTabIds(store),
      'an un-hydrated target never recovered the host tabs it declined to guess at'
    ).toEqual(['T1', 'T2', 'T3'])
    expect(isHydrated(store)).toBe(true)
    expect(syncPhase(store)).toBe('synced')
  })

  it('still hydrates when the host genuinely reported no terminals', async () => {
    const store = createStore()
    expect(store.getState().worktreesByRepo).toEqual({})

    // No rows were dropped here, so an empty local result is a faithful picture of the host.
    await applySnapshot(store, emptySnapshot(1))

    expect(adoptedTabIds(store)).toEqual([])
    expect(isHydrated(store)).toBe(true)
    expect(syncPhase(store)).toBe('synced')
  })
})
