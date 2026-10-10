/**
 * A client that has never held a direct-SSH workspace — a re-added host, a cleared profile, a second
 * machine — activates it before the host snapshot lands and seeds an initial terminal into that gap.
 * The snapshot then arrives, the merge correctly keeps the locally-created tab it was never told
 * about, and the union uploads as the new host truth.
 *
 * Scope, because it moved twice under investigation: an ordinary RESTART does not reach this, since
 * local session state restores the workspace's tab row first. The trigger is a client with no local
 * row for a workspace the host already owns (#15556 / STA-4908).
 *
 * Two oracles. Cardinality: the client must not add a tab the host did not name. Adoption: declining
 * to seed must not cost the user the host's real tabs — an empty workspace is not an improvement on
 * a wrong one.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RemoteWorkspaceObservedSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
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

function snapshot(revision: number, tabIds: readonly string[]): RemoteWorkspaceObservedSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    hostObservationToken: `observation-${revision}`,
    session: {
      activeWorktreePath: PATH,
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
    // Why: only the IPC-backed reconnect is stubbed; hydration bookkeeping stays real because it is
    // the very signal under test.
    reconnectPersistedTerminals: (async () => {}) as never,
    setRemoteWorkspaceSyncStatus: (() => {}) as never
  })
}

/** A relaunch: the workspace's tab rows and this session's host answers are both gone. */
function simulateColdStart(store: TestStore): void {
  const live = store.getState()
  const { [WORKTREE_ID]: _tabs, ...tabsByWorktree } = live.tabsByWorktree
  const { [WORKTREE_ID]: _unified, ...unifiedTabsByWorktree } = live.unifiedTabsByWorktree
  store.setState({
    tabsByWorktree,
    unifiedTabsByWorktree,
    remoteWorkspaceHydratedTargetIds: new Set<string>()
  })
}

function terminalTabIds(store: TestStore): string[] {
  return (store.getState().tabsByWorktree[WORKTREE_ID] ?? []).map((tab) => tab.id)
}

describe('a fresh client meeting a workspace the host already owns', () => {
  it('holds one tab when the host still reports one tab', async () => {
    const store = createTestStore()
    seedCatalog(store)

    // Yesterday: the host owns exactly one terminal in this workspace.
    await applySnapshot(store, snapshot(1, ['T1']))
    expect(terminalTabIds(store)).toEqual(['T1'])

    // This morning: the app restarts and activates the workspace before SSH has answered.
    simulateColdStart(store)
    ensureWorktreeHasInitialTerminal(store.getState(), WORKTREE_ID)

    // The host answers, still holding only T1.
    await applySnapshot(store, snapshot(2, ['T1']))

    expect(
      terminalTabIds(store),
      'the launch seeded a terminal into the gap before the host answered'
    ).toEqual(['T1'])
  })

  it('adopts every tab the host owns instead of replacing them with a seeded one', async () => {
    const store = createTestStore()
    seedCatalog(store)

    // A client with no local row for this workspace, activating it before the snapshot lands.
    expect(store.getState().tabsByWorktree[WORKTREE_ID]).toBeUndefined()
    ensureWorktreeHasInitialTerminal(store.getState(), WORKTREE_ID)

    await applySnapshot(store, snapshot(1, ['T1', 'T2', 'T3']))

    expect(
      terminalTabIds(store),
      'declining to seed must not also cost the user the tabs the host really owns'
    ).toEqual(['T1', 'T2', 'T3'])
  })
})
