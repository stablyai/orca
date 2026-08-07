/**
 * A direct-SSH snapshot can reference worktree paths the local catalog has not
 * resolved yet (remote catalogs fill in asynchronously, often only when the
 * user activates the worktree). These tests exercise the deferred-hydration
 * watcher in applyDirectSshRemoteWorkspaceSnapshot: late-resolving paths must
 * still hydrate — additively, without moving focus, and without resetting
 * worktrees the main pass already hydrated — and paths that never resolve must
 * surface an error sync status at the deadline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import type { RemoteWorkspaceSyncStatus } from '../store/slices/ssh'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import { applyDirectSshRemoteWorkspaceSnapshot } from './remote-workspace-snapshot-apply'
import type { DirectSshSnapshotApplyToken } from './direct-ssh-reconnect-coordinator-types'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const TARGET_ID = 'ssh-target-1'
const EAGER_PATH = '/srv/proj/wt-eager'
const LATE_PATH = '/srv/proj/wt-late'
const EAGER_ID = `repoA::${EAGER_PATH}`
const LATE_ID = `repoA::${LATE_PATH}`
const POLL_MS = 1_000
const DEADLINE_MS = 600_000

const authority: DirectSshAuthority = {
  targetId: TARGET_ID,
  providerEpoch: 'provider-epoch-1' as SshProviderEpoch,
  connectionGeneration: 1
}

function token(snapshotRevision: number): DirectSshSnapshotApplyToken {
  return {
    authority,
    catalogRevision: 0,
    repoFingerprint: 'fp',
    authorityRequirement: 'required',
    snapshotRevision,
    outcome: 'complete'
  }
}

function snapshot(
  revision: number,
  tabIdsByPath: Record<string, readonly string[]>
): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    session: {
      activeWorktreePath: null,
      activeTabId: null,
      tabsByWorktreePath: Object.fromEntries(
        Object.entries(tabIdsByPath).map(([worktreePath, tabIds]) => [
          worktreePath,
          tabIds.map((tabId, index) => ({
            id: tabId,
            worktreePath,
            ptyId: `pty-${tabId}`,
            title: `Terminal ${index + 1}`,
            customTitle: null,
            color: null,
            sortOrder: index,
            createdAt: index + 1
          }))
        ])
      ),
      terminalLayoutsByTabId: {},
      activeWorktreePathsOnShutdown: [],
      activeTabIdByWorktreePath: {},
      remoteSessionIdsByTabId: {},
      lastVisitedAtByWorktreePath: {},
      defaultTerminalTabsAppliedByWorktreePath: {}
    }
  } satisfies RemoteWorkspaceSnapshot
}

type TestStore = ReturnType<typeof createTestStore>

function makeStore(syncStatuses: RemoteWorkspaceSyncStatus[]): TestStore {
  const store = createTestStore()
  store.setState({
    repos: [
      {
        id: 'repoA',
        path: '/srv/proj',
        displayName: 'Proj',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: TARGET_ID
      } as never
    ],
    reconnectPersistedTerminals: (async () => {}) as never,
    markRemoteWorkspaceHydrated: (() => {}) as never,
    setRemoteWorkspaceSyncStatus: ((_targetId: string, status: RemoteWorkspaceSyncStatus) => {
      syncStatuses.push(status)
    }) as never
  })
  return store
}

function seedCatalog(store: TestStore, worktreePaths: string[]): void {
  store.setState({
    worktreesByRepo: {
      repoA: worktreePaths.map(
        (path) =>
          makeWorktree({
            id: `repoA::${path}`,
            repoId: 'repoA',
            path,
            hostId: `ssh:${TARGET_ID}`
          } as never) as never
      )
    }
  })
}

function applySnapshot(
  store: TestStore,
  snap: RemoteWorkspaceSnapshot,
  getCurrentAuthority: (targetId: string) => DirectSshAuthority | null = () => authority
): Promise<void> {
  return applyDirectSshRemoteWorkspaceSnapshot({
    store,
    snapshot: snap,
    token: token(snap.revision),
    arrival: 1,
    isArrivalCurrent: () => true,
    isPreparationTokenCurrent: () => true,
    getCurrentAuthority,
    waitForWorkspaceSessionReady: async () => true,
    finalizeHydratedTerminals: () => 0
  })
}

function tabIds(store: TestStore, worktreeId: string): string[] {
  return (store.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
}

describe('direct-SSH snapshot apply, deferred worktree hydration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hydrates a late-resolving worktree additively without moving focus or resetting eager worktrees', async () => {
    const syncStatuses: RemoteWorkspaceSyncStatus[] = []
    const store = makeStore(syncStatuses)
    seedCatalog(store, [EAGER_PATH])

    const applyPromise = applySnapshot(
      store,
      snapshot(1, { [EAGER_PATH]: ['tab-e1'], [LATE_PATH]: ['tab-l1'] })
    )
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(tabIds(store, EAGER_ID)).toEqual(['tab-e1'])
    expect(tabIds(store, LATE_ID)).toEqual([])

    // The user keeps working while the late path is unresolved: a new tab on the
    // eager worktree, a live tab on the late one, and focus on the eager tab.
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        [EAGER_ID]: [
          ...store.getState().tabsByWorktree[EAGER_ID],
          { id: 'tab-e2', worktreeId: EAGER_ID, title: 'T2', ptyId: 'pty-tab-e2' } as never
        ],
        [LATE_ID]: [
          { id: 'tab-live', worktreeId: LATE_ID, title: 'Live', ptyId: 'pty-tab-live' } as never
        ]
      },
      activeWorktreeId: EAGER_ID,
      activeTabId: 'tab-e2'
    })

    seedCatalog(store, [EAGER_PATH, LATE_PATH])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await applyPromise

    expect(tabIds(store, LATE_ID).sort()).toEqual(['tab-l1', 'tab-live'])
    expect(tabIds(store, EAGER_ID)).toEqual(['tab-e1', 'tab-e2'])
    expect(store.getState().activeWorktreeId).toBe(EAGER_ID)
    expect(store.getState().activeTabId).toBe('tab-e2')
    expect(syncStatuses.at(-1)?.phase).toBe('synced')
  })

  it('registers the pending path for the initial-terminal gate and clears it on resolution', async () => {
    const store = makeStore([])
    seedCatalog(store, [EAGER_PATH])

    const applyPromise = applySnapshot(
      store,
      snapshot(1, { [EAGER_PATH]: ['tab-e1'], [LATE_PATH]: ['tab-l1'] })
    )
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(store.getState().pendingDeferredWorktreePathsByTargetId[TARGET_ID]).toEqual([LATE_PATH])

    seedCatalog(store, [EAGER_PATH, LATE_PATH])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await applyPromise

    expect(store.getState().pendingDeferredWorktreePathsByTargetId[TARGET_ID]).toBeUndefined()
  })

  it('late-hydrates a path that resolves while the apply awaits terminal reconnects', async () => {
    const syncStatuses: RemoteWorkspaceSyncStatus[] = []
    const store = makeStore(syncStatuses)
    seedCatalog(store, [EAGER_PATH])
    // The catalog resolves the late path while the main hydrate is still
    // awaiting terminal reconnects — after the import already dropped its tabs.
    // The watch's first pass must late-hydrate it without waiting for a poll
    // tick: gates read "hydrated, nothing pending" as fully loaded, and a
    // missing tab in a fully loaded worktree is treated as gone for good.
    store.setState({
      reconnectPersistedTerminals: (async () => {
        seedCatalog(store, [EAGER_PATH, LATE_PATH])
      }) as never
    })

    const applyPromise = applySnapshot(
      store,
      snapshot(1, { [EAGER_PATH]: ['tab-e1'], [LATE_PATH]: ['tab-l1'] })
    )
    await vi.advanceTimersByTimeAsync(0)
    await applyPromise

    expect(tabIds(store, LATE_ID)).toEqual(['tab-l1'])
    expect(store.getState().pendingDeferredWorktreePathsByTargetId[TARGET_ID]).toBeUndefined()
    expect(syncStatuses.at(-1)?.phase).toBe('synced')
  })

  it('sets an error sync status when a path never resolves before the deadline', async () => {
    const syncStatuses: RemoteWorkspaceSyncStatus[] = []
    const store = makeStore(syncStatuses)

    const applyPromise = applySnapshot(store, snapshot(1, { [LATE_PATH]: ['tab-l1'] }))
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + POLL_MS)
    await applyPromise

    expect(tabIds(store, LATE_ID)).toEqual([])
    expect(syncStatuses.at(-1)?.phase).toBe('error')
  })

  it('reports an error instead of a false synced status when a pending path turns ambiguous', async () => {
    const syncStatuses: RemoteWorkspaceSyncStatus[] = []
    const store = makeStore(syncStatuses)

    const applyPromise = applySnapshot(store, snapshot(1, { [LATE_PATH]: ['tab-l1'] }))
    await vi.advanceTimersByTimeAsync(POLL_MS)

    // The catalog gains the path twice (two worktrees, same path): it can never
    // resolve uniquely, so the watch must end with an error, not "synced".
    store.setState({
      worktreesByRepo: {
        repoA: [
          makeWorktree({
            id: `repoA::${LATE_PATH}`,
            repoId: 'repoA',
            path: LATE_PATH,
            hostId: `ssh:${TARGET_ID}`
          } as never) as never,
          makeWorktree({
            id: `repoB::${LATE_PATH}`,
            repoId: 'repoB',
            path: LATE_PATH,
            hostId: `ssh:${TARGET_ID}`
          } as never) as never
        ]
      }
    })
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)
    await applyPromise

    expect(syncStatuses.at(-1)?.phase).toBe('error')
  })

  it('keeps the error status when another path hydrates after an ambiguous one was dropped', async () => {
    const syncStatuses: RemoteWorkspaceSyncStatus[] = []
    const store = makeStore(syncStatuses)

    const applyPromise = applySnapshot(
      store,
      snapshot(1, { [EAGER_PATH]: ['tab-e1'], [LATE_PATH]: ['tab-l1'] })
    )
    await vi.advanceTimersByTimeAsync(POLL_MS)

    // Tick 2: EAGER_PATH appears ambiguously (two worktrees, same path) — dropped with an error.
    store.setState({
      worktreesByRepo: {
        repoA: [
          makeWorktree({
            id: `repoA::${EAGER_PATH}`,
            repoId: 'repoA',
            path: EAGER_PATH,
            hostId: `ssh:${TARGET_ID}`
          } as never) as never,
          makeWorktree({
            id: `repoB::${EAGER_PATH}`,
            repoId: 'repoB',
            path: EAGER_PATH,
            hostId: `ssh:${TARGET_ID}`
          } as never) as never
        ]
      }
    })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(syncStatuses.at(-1)?.phase).toBe('error')

    // Tick 3: LATE_PATH resolves uniquely and hydrates; the earlier tab loss must stay visible.
    store.setState({
      worktreesByRepo: {
        ...store.getState().worktreesByRepo,
        repoC: [
          makeWorktree({
            id: `repoC::${LATE_PATH}`,
            repoId: 'repoC',
            path: LATE_PATH,
            hostId: `ssh:${TARGET_ID}`
          } as never) as never
        ]
      }
    })
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)
    await applyPromise

    expect(tabIds(store, `repoC::${LATE_PATH}`)).toEqual(['tab-l1'])
    expect(syncStatuses.some((status) => status.phase === 'synced')).toBe(true)
    expect(syncStatuses.at(-1)?.phase).toBe('error')
  })

  it('re-asserts the error even when the connection dies during the late hydrate', async () => {
    const syncStatuses: RemoteWorkspaceSyncStatus[] = []
    const store = makeStore(syncStatuses)
    let liveAuthority: DirectSshAuthority | null = authority
    let reconnectCalls = 0
    store.setState({
      // The second reconnect (the late hydrate's) severs the connection mid-hydrate.
      reconnectPersistedTerminals: (async () => {
        reconnectCalls += 1
        if (reconnectCalls > 1) {
          liveAuthority = null
        }
      }) as never
    })

    const applyPromise = applySnapshot(
      store,
      snapshot(1, { [EAGER_PATH]: ['tab-e1'], [LATE_PATH]: ['tab-l1'] }),
      () => liveAuthority
    )
    await vi.advanceTimersByTimeAsync(POLL_MS)

    store.setState({
      worktreesByRepo: {
        repoA: [
          makeWorktree({
            id: `repoA::${EAGER_PATH}`,
            repoId: 'repoA',
            path: EAGER_PATH,
            hostId: `ssh:${TARGET_ID}`
          } as never) as never,
          makeWorktree({
            id: `repoB::${EAGER_PATH}`,
            repoId: 'repoB',
            path: EAGER_PATH,
            hostId: `ssh:${TARGET_ID}`
          } as never) as never
        ]
      }
    })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(syncStatuses.at(-1)?.phase).toBe('error')

    store.setState({
      worktreesByRepo: {
        ...store.getState().worktreesByRepo,
        repoC: [
          makeWorktree({
            id: `repoC::${LATE_PATH}`,
            repoId: 'repoC',
            path: LATE_PATH,
            hostId: `ssh:${TARGET_ID}`
          } as never) as never
        ]
      }
    })
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)
    await applyPromise

    expect(syncStatuses.at(-1)?.phase).toBe('error')
  })

  it('stops watching without hydrating or reporting sync state once the authority is gone', async () => {
    const syncStatuses: RemoteWorkspaceSyncStatus[] = []
    const store = makeStore(syncStatuses)
    let liveAuthority: DirectSshAuthority | null = authority

    const applyPromise = applySnapshot(
      store,
      snapshot(1, { [LATE_PATH]: ['tab-l1'] }),
      () => liveAuthority
    )
    await vi.advanceTimersByTimeAsync(POLL_MS)
    const statusesBeforeDisconnect = syncStatuses.length

    // The connection drops; the catalog resolving afterwards must not hydrate
    // against the dead authority or claim the workspace is synced.
    liveAuthority = null
    seedCatalog(store, [LATE_PATH])
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    await applyPromise

    expect(tabIds(store, LATE_ID)).toEqual([])
    expect(syncStatuses.length).toBe(statusesBeforeDisconnect)
  })
})
