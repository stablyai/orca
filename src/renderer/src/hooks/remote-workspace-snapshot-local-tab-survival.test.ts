/**
 * Reconnecting an SSH workspace must not delete local state the host has not been told about.
 *
 * Reported from a 60-second manual test: reconnect, and a second tab that was running `pnpm install`
 * is gone while the app drops to the home screen. Both come from the same place — the host snapshot
 * is applied as the whole truth for the reconnecting target, so a tab created locally but not yet
 * uploaded has no branch that keeps it, and a snapshot that names no active worktree nulls the one
 * the user is standing in.
 *
 * This drives the real apply path rather than the merge function alone, and it is deterministic: the
 * end-to-end version of the same scenario only reproduces about one run in three, because the bug
 * needs the tab to be created inside the debounced upload's suppression window.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RemoteWorkspaceObservedSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import { applyDirectSshRemoteWorkspaceSnapshot } from './remote-workspace-snapshot-apply'
import type { DirectSshSnapshotApplyToken } from './direct-ssh-reconnect-coordinator-types'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const TARGET_ID = 'ssh-target-1'
const PATH = '/srv/proj/bug-cats'
const WORKTREE_ID = `repoA::${PATH}`

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
  tabIds: readonly string[],
  options: { activeWorktreePath?: string | null } = {}
): RemoteWorkspaceObservedSnapshot {
  const activeWorktreePath =
    options.activeWorktreePath === undefined ? PATH : options.activeWorktreePath
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    hostObservationToken: `observation-${revision}`,
    session: {
      activeWorktreePath,
      activeTabId: tabIds[0] ?? null,
      tabsByWorktreePath: {
        [PATH]: tabIds.map((tabId, index) => ({
          id: tabId,
          worktreePath: PATH,
          ptyId: `pty-${tabId}`,
          title: `Terminal ${index + 1}`,
          customTitle: null,
          color: null,
          sortOrder: index,
          createdAt: index + 1
        }))
      },
      terminalLayoutsByTabId: {},
      activeWorktreePathsOnShutdown: [],
      activeTabIdByWorktreePath: { [PATH]: tabIds[0] ?? null },
      remoteSessionIdsByTabId: Object.fromEntries(tabIds.map((id) => [id, `pty-${id}`])),
      lastVisitedAtByWorktreePath: { [PATH]: revision },
      defaultTerminalTabsAppliedByWorktreePath: { [PATH]: true }
    }
  } satisfies RemoteWorkspaceObservedSnapshot
}

type TestStore = ReturnType<typeof createTestStore>

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

function seedCatalog(store: TestStore): void {
  store.setState({
    worktreesByRepo: {
      repoA: [
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repoA',
          path: PATH,
          hostId: `ssh:${TARGET_ID}`
        } as never)
      ]
    },
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
    setRemoteWorkspaceSyncStatus: (() => {}) as never
  })
}

/** A tab the user created locally whose upload has not landed yet. */
function addLocalTab(store: TestStore, tabId: string): void {
  const live = store.getState()
  store.setState({
    tabsByWorktree: {
      ...live.tabsByWorktree,
      [WORKTREE_ID]: [
        ...(live.tabsByWorktree[WORKTREE_ID] ?? []),
        {
          id: tabId,
          worktreeId: WORKTREE_ID,
          type: 'terminal',
          title: tabId
        } as never
      ]
    }
  })
}

describe('direct-SSH snapshot apply keeps local state the host has not seen', () => {
  it('keeps a tab created locally between snapshots', async () => {
    const store = createTestStore()
    seedCatalog(store)
    await applySnapshot(store, snapshot(1, ['agent']))
    store.getState().setActiveWorktree(WORKTREE_ID)

    // The reported `setup` tab: created after the first snapshot, upload still pending, so the next
    // snapshot the host sends still knows only about `agent`.
    addLocalTab(store, 'setup')
    await applySnapshot(store, snapshot(2, ['agent']))

    const tabIds = (store.getState().tabsByWorktree[WORKTREE_ID] ?? []).map((tab) => tab.id)
    expect(tabIds, 'the reconnect deleted a tab the host had never been told about').toContain(
      'setup'
    )
    expect(tabIds).toContain('agent')
  })

  it('leaves the user on their workspace when the snapshot names no active worktree', async () => {
    const store = createTestStore()
    seedCatalog(store)
    await applySnapshot(store, snapshot(1, ['agent']))
    store.getState().setActiveWorktree(WORKTREE_ID)
    expect(store.getState().activeWorktreeId).toBe(WORKTREE_ID)

    // A snapshot whose active path does not resolve to a known worktree. Taking that as "no active
    // workspace" is what drops the user to the home screen mid-session.
    await applySnapshot(store, snapshot(2, ['agent'], { activeWorktreePath: null }))

    expect(
      store.getState().activeWorktreeId,
      'the reconnect dropped the user to the home screen'
    ).toBe(WORKTREE_ID)
  })

  it('still follows the host when the snapshot does name an active worktree', async () => {
    const store = createTestStore()
    seedCatalog(store)
    await applySnapshot(store, snapshot(1, ['agent']))
    store.getState().setActiveWorktree(WORKTREE_ID)

    await applySnapshot(store, snapshot(2, ['agent'], { activeWorktreePath: PATH }))

    expect(store.getState().activeWorktreeId).toBe(WORKTREE_ID)
  })

  it('does not duplicate a tab across repeated snapshots', async () => {
    const store = createTestStore()
    seedCatalog(store)
    await applySnapshot(store, snapshot(1, ['agent']))
    store.getState().setActiveWorktree(WORKTREE_ID)
    addLocalTab(store, 'setup')

    await applySnapshot(store, snapshot(2, ['agent']))
    await applySnapshot(store, snapshot(3, ['agent']))

    const tabIds = (store.getState().tabsByWorktree[WORKTREE_ID] ?? []).map((tab) => tab.id)
    expect(tabIds).toEqual([...new Set(tabIds)])
    expect(tabIds.filter((id) => id === 'setup')).toHaveLength(1)
  })
})
