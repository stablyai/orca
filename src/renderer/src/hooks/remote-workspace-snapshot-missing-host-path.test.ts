/**
 * #22590: a worktree removed outside Orca leaves terminal rows under a host path nothing can ever
 * place again. Without positive evidence the apply keeps such rows `unverifiable` and parks the
 * whole target in `conflict`, which has no exit and freezes uploads for every worktree on the host.
 *
 * The oracle: only a host ENOENT releases a path. `exists: true`, a per-path error, or a failed
 * batch all keep today's conflict, because those rows may still be ours.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { PathExistenceResult } from '../../../shared/path-existence-batch'
import type { RemoteWorkspaceObservedSnapshot } from '../../../shared/remote-workspace-types'
import type { Repo } from '../../../shared/repo-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import { applyDirectSshRemoteWorkspaceSnapshot } from './remote-workspace-snapshot-apply'
import {
  findPathsMissingOnHost,
  HOST_PATH_MISSING_CONFIRM_DELAY_MS,
  type ReadHostPathExistence
} from './remote-workspace-missing-host-paths'
import type { DirectSshSnapshotApplyToken } from './direct-ssh-reconnect-coordinator-types'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const TARGET_ID = 'ssh-target-1'
const REPO_ROOT = '/srv/proj'
const ALPHA = `${REPO_ROOT}/alpha`
const REMOVED = `${REPO_ROOT}/removed`
const ALPHA_ID = `repoA::${ALPHA}`
const REMOVED_ID = `repoA::${REMOVED}`

const authority: DirectSshAuthority = {
  targetId: TARGET_ID,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: branded id with no public constructor; any string is a valid epoch in tests.
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
    outcome: 'degraded'
  }
}

function tabRow(worktreePath: string, tabId: string, sortOrder: number) {
  return {
    id: tabId,
    worktreePath,
    ptyId: null,
    title: tabId,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

/** One live worktree and one whose directory was removed on the host. */
function snapshot(revision: number): RemoteWorkspaceObservedSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    hostObservationToken: `observation-${revision}`,
    session: {
      activeWorktreePath: ALPHA,
      activeTabId: 'T1',
      tabsByWorktreePath: {
        [ALPHA]: [tabRow(ALPHA, 'T1', 0)],
        [REMOVED]: [tabRow(REMOVED, 'GHOST', 0)]
      },
      terminalLayoutsByTabId: {},
      activeWorktreePathsOnShutdown: [],
      activeTabIdByWorktreePath: { [ALPHA]: 'T1', [REMOVED]: 'GHOST' },
      remoteSessionIdsByTabId: {},
      lastVisitedAtByWorktreePath: {},
      defaultTerminalTabsAppliedByWorktreePath: {}
    }
  } satisfies RemoteWorkspaceObservedSnapshot
}

type TestStore = ReturnType<typeof createTestStore>

function repoRow(id: string, connectionId: string | null): Repo {
  return {
    id,
    path: REPO_ROOT,
    displayName: 'Proj',
    badgeColor: '#000',
    addedAt: 0,
    connectionId
  }
}

function createStore(): TestStore {
  const store = createTestStore()
  store.setState({
    repos: [repoRow('repoA', TARGET_ID)],
    reconnectPersistedTerminals: async () => {},
    worktreesByRepo: {
      repoA: [
        makeWorktree({
          id: ALPHA_ID,
          repoId: 'repoA',
          path: ALPHA,
          hostId: `ssh:${TARGET_ID}`
        })
      ]
    }
  })
  return store
}

/** The client still holds rows for the removed worktree, as in the #22590 report. */
function addClientGhostRow(store: TestStore, worktreeId: string = REMOVED_ID): void {
  store.setState({
    tabsByWorktree: {
      ...store.getState().tabsByWorktree,
      [worktreeId]: [
        {
          id: 'GHOST',
          worktreeId,
          ptyId: null,
          title: 'GHOST',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        } satisfies TerminalTab
      ]
    }
  })
}

function existence(answer: PathExistenceResult): ReadHostPathExistence {
  return async (_targetId, paths) => paths.map(() => answer)
}

/** Answers per probe; the last answer repeats. */
function probes(...answers: PathExistenceResult[]): ReadHostPathExistence {
  let call = 0
  return async (_targetId, paths) => {
    const answer = answers[Math.min(call, answers.length - 1)]
    call += 1
    return paths.map(() => answer)
  }
}

async function applySnapshot(
  store: TestStore,
  readHostPathExistence: ReadHostPathExistence | undefined,
  onUnplaced?: (paths: readonly string[]) => void
): Promise<void> {
  vi.useFakeTimers()
  try {
    const pending = applyDirectSshRemoteWorkspaceSnapshot({
      store,
      snapshot: snapshot(7),
      token: token(7),
      arrival: 1,
      isArrivalCurrent: () => true,
      isPreparationTokenCurrent: () => true,
      waitForWorkspaceSessionReady: async () => true,
      finalizeHydratedTerminals: () => 0,
      onUnplacedTabWorktreePaths: onUnplaced,
      readHostPathExistence
    })
    await vi.advanceTimersByTimeAsync(10_000 + HOST_PATH_MISSING_CONFIRM_DELAY_MS)
    await pending
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
}

function syncStatus(store: TestStore) {
  return store.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]
}

function isHydrated(store: TestStore): boolean {
  return store.getState().remoteWorkspaceHydratedTargetIds.has(TARGET_ID)
}

describe('host snapshot rows under a path the host reports gone', () => {
  it('syncs instead of parking the target in conflict', async () => {
    const store = createStore()
    const onUnplaced = vi.fn()

    await applySnapshot(store, existence({ exists: false }), onUnplaced)

    expect(syncStatus(store)?.phase).toBe('synced')
    expect(isHydrated(store), 'uploads stay frozen while the target is un-hydrated').toBe(true)
    expect(store.getState().tabsByWorktree[ALPHA_ID]?.map((tab) => tab.id)).toEqual(['T1'])
    // An empty list retires the deferred placement watch instead of arming one for a dead path.
    expect(onUnplaced).toHaveBeenLastCalledWith([])
  })

  it('purges the client rows for that path so the next upload stops re-publishing them', async () => {
    const store = createStore()
    addClientGhostRow(store)

    await applySnapshot(store, existence({ exists: false }))

    expect(store.getState().tabsByWorktree[REMOVED_ID]).toBeUndefined()
    expect(store.getState().tabsByWorktree[ALPHA_ID]?.map((tab) => tab.id)).toEqual(['T1'])
  })

  it('leaves client rows alone when the repo id is also registered on another host', async () => {
    const store = createStore()
    store.setState({
      repos: [repoRow('repoA', TARGET_ID), repoRow('repoA', null)]
    })
    addClientGhostRow(store)

    await applySnapshot(store, existence({ exists: false }))

    expect(store.getState().tabsByWorktree[REMOVED_ID]?.map((tab) => tab.id)).toEqual(['GHOST'])
    // The surviving row would be re-published by the next upload, so the target cannot sync.
    expect(syncStatus(store)?.phase).toBe('conflict')
  })

  it('purges rows of a repo whose ssh owner is stamped only as executionHostId', async () => {
    const store = createStore()
    store.setState({
      repos: [{ ...repoRow('repoA', null), executionHostId: `ssh:${TARGET_ID}` }]
    })
    addClientGhostRow(store)

    await applySnapshot(store, existence({ exists: false }))

    expect(store.getState().tabsByWorktree[REMOVED_ID]).toBeUndefined()
    expect(syncStatus(store)?.phase).toBe('synced')
  })

  it('keeps the conflict, with the path in the message, when the directory still exists', async () => {
    const store = createStore()

    await applySnapshot(store, existence({ exists: true }))

    expect(syncStatus(store)?.phase).toBe('conflict')
    expect(syncStatus(store)?.message).toContain(REMOVED)
    expect(isHydrated(store)).toBe(false)
  })

  it('keeps the conflict when the host could not answer', async () => {
    const perPathError = createStore()
    await applySnapshot(perPathError, existence({ error: 'EACCES' }))
    expect(syncStatus(perPathError)?.phase).toBe('conflict')

    const failedBatch = createStore()
    await applySnapshot(failedBatch, async () => {
      throw new Error('relay dropped')
    })
    expect(syncStatus(failedBatch)?.phase).toBe('conflict')
    expect(isHydrated(failedBatch)).toBe(false)
  })

  it('keeps the conflict and the client rows when the confirming probe finds the path again', async () => {
    const store = createStore()
    addClientGhostRow(store)

    await applySnapshot(store, probes({ exists: false }, { exists: true }))

    expect(syncStatus(store)?.phase).toBe('conflict')
    expect(store.getState().tabsByWorktree[REMOVED_ID]?.map((tab) => tab.id)).toEqual(['GHOST'])
  })

  it('does not purge rows of a worktree the catalog places while the host is being probed', async () => {
    const store = createStore()
    addClientGhostRow(store)
    let call = 0
    const read: ReadHostPathExistence = async (_targetId, paths) => {
      call += 1
      if (call === 2) {
        const { worktreesByRepo } = store.getState()
        store.setState({
          worktreesByRepo: {
            ...worktreesByRepo,
            repoA: [
              ...(worktreesByRepo.repoA ?? []),
              makeWorktree({
                id: REMOVED_ID,
                repoId: 'repoA',
                path: REMOVED,
                hostId: `ssh:${TARGET_ID}`
              })
            ]
          }
        })
      }
      return paths.map((): PathExistenceResult => ({ exists: false }))
    }

    await applySnapshot(store, read)

    expect(store.getState().tabsByWorktree[REMOVED_ID]?.map((tab) => tab.id)).toContain('GHOST')
  })

  it('keeps the conflict when two placed worktrees share the gone path', async () => {
    const store = createStore()
    const twinId = `repoB::${REMOVED}`
    const { worktreesByRepo } = store.getState()
    store.setState({
      repos: [repoRow('repoA', TARGET_ID), repoRow('repoB', TARGET_ID)],
      worktreesByRepo: {
        ...worktreesByRepo,
        repoA: [
          ...(worktreesByRepo.repoA ?? []),
          makeWorktree({
            id: REMOVED_ID,
            repoId: 'repoA',
            path: REMOVED,
            hostId: `ssh:${TARGET_ID}`
          })
        ],
        repoB: [
          makeWorktree({ id: twinId, repoId: 'repoB', path: REMOVED, hostId: `ssh:${TARGET_ID}` })
        ]
      }
    })
    addClientGhostRow(store)

    await applySnapshot(store, existence({ exists: false }))

    // Placement refuses the ambiguous path, and the purge must not drop a row the catalog names;
    // the row survives, so the next upload would re-publish it and the target cannot sync.
    expect(store.getState().tabsByWorktree[REMOVED_ID]?.map((tab) => tab.id)).toEqual(['GHOST'])
    expect(syncStatus(store)?.phase).toBe('conflict')
  })

  it('matches client rows whose key spells the host path differently', async () => {
    const store = createStore()
    const trailingSlashId = `repoA::${REMOVED}/`
    addClientGhostRow(store, trailingSlashId)

    await applySnapshot(store, existence({ exists: false }))

    expect(store.getState().tabsByWorktree[trailingSlashId]).toBeUndefined()
  })

  it('keeps the conflict when no existence reader is wired', async () => {
    const store = createStore()

    await applySnapshot(store, undefined)

    expect(syncStatus(store)?.phase).toBe('conflict')
  })
})

describe('findPathsMissingOnHost', () => {
  it('reports only positive ENOENT answers, across batches', async () => {
    const paths = Array.from({ length: 130 }, (_, index) => `/p/${index}`)
    const read = vi.fn<ReadHostPathExistence>(async (_targetId, batch) =>
      batch.map((path): PathExistenceResult => {
        if (path === '/p/1') {
          return { error: 'EIO' }
        }
        return { exists: path !== '/p/0' && path !== '/p/129' }
      })
    )

    const missing = await findPathsMissingOnHost(read, TARGET_ID, [...paths, '/p/0'])

    expect([...missing].sort()).toEqual(['/p/0', '/p/129'])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('treats a short answer as unverifiable', async () => {
    const missing = await findPathsMissingOnHost(async () => [], TARGET_ID, ['/gone'])
    expect(missing.size).toBe(0)
  })
})
