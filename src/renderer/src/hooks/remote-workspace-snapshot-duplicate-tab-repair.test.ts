/**
 * A direct-SSH snapshot can retain the same tab under old and new worktree IDs
 * after a path or repo-ID change. The target-scoped merge must reject the
 * ambiguous owner before tab-keyed terminal state can move between worktrees.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
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
const OLD_PATH = '/srv/proj/wt'
const NEW_PATH = '/srv/proj/wt-renamed'
const OLD_ID = `repoA::${OLD_PATH}`
const NEW_ID = `repoA::${NEW_PATH}`

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
  worktreePath: string,
  tabIds: readonly string[],
  activeTabId: string | null
): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    session: {
      activeWorktreePath: worktreePath,
      activeTabId,
      tabsByWorktreePath: {
        [worktreePath]: tabIds.map((tabId, index) => ({
          id: tabId,
          worktreePath,
          ptyId: `ssh:${TARGET_ID}@@pty-${tabId}`,
          title: `Terminal ${index + 1}`,
          customTitle: null,
          color: null,
          sortOrder: index,
          createdAt: index + 1
        }))
      },
      terminalLayoutsByTabId: {},
      activeWorktreePathsOnShutdown: [],
      activeTabIdByWorktreePath: { [worktreePath]: activeTabId },
      remoteSessionIdsByTabId: Object.fromEntries(
        tabIds.map((id) => [id, `ssh:${TARGET_ID}@@pty-${id}`])
      ),
      lastVisitedAtByWorktreePath: { [worktreePath]: revision },
      defaultTerminalTabsAppliedByWorktreePath: { [worktreePath]: true }
    }
  } satisfies RemoteWorkspaceSnapshot
}

type TestStore = ReturnType<typeof createTestStore>

async function applySnapshot(store: TestStore, snap: RemoteWorkspaceSnapshot): Promise<void> {
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

function worktreeIdsOwningTab(store: TestStore, tabId: string): string[] {
  return Object.entries(store.getState().tabsByWorktree)
    .filter(([, tabs]) => tabs.some((tab) => tab.id === tabId))
    .map(([worktreeId]) => worktreeId)
}

function seedCatalog(store: TestStore, worktreePath: string): void {
  store.setState({
    worktreesByRepo: {
      repoA: [
        makeWorktree({
          id: `repoA::${worktreePath}`,
          repoId: 'repoA',
          path: worktreePath,
          hostId: `ssh:${TARGET_ID}`
        } as never)
      ]
    }
  })
}

describe('direct-SSH snapshot apply, tab id owned by two worktrees', () => {
  it('rejects the second owner before tab-keyed PTY state is contaminated', async () => {
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
      // Load-bearing, do not drop: the IPC attach is the only thing stubbed, and
      // it leaves behind exactly what a real reconnect leaves behind — one
      // registered live PTY per tab. Without that the orphan sweep on the next
      // worktree visit treats the duplicated tab as dead, cleans it up, and the
      // bug evaporates before the repair effect ever sees it.
      reconnectPersistedTerminals: (async () => {
        const live = store.getState()
        const registered: Record<string, string[]> = { ...live.ptyIdsByTabId }
        for (const tabs of Object.values(live.tabsByWorktree)) {
          for (const tab of tabs) {
            registered[tab.id] = [`pty-${tab.id}`]
          }
        }
        store.setState({ ptyIdsByTabId: registered })
      }) as never,
      markRemoteWorkspaceHydrated: (() => {}) as never
    })

    seedCatalog(store, OLD_PATH)
    await applySnapshot(store, snapshot(1, OLD_PATH, ['tab-1', 'tab-2'], 'tab-1'))
    store.getState().setActiveWorktree(OLD_ID)

    // The worktree is renamed on the host; the catalog re-detects it at the new
    // path, so the worktree id changes while the tab ids do not.
    seedCatalog(store, NEW_PATH)
    await applySnapshot(store, snapshot(2, NEW_PATH, ['tab-1', 'tab-2'], 'tab-1'))
    store.getState().setActiveWorktree(NEW_ID)

    // The remote deselects; importRemoteWorkspaceSession nulls an activeTabId it
    // cannot find among the imported tabs, which is what arms the repair effect.
    await applySnapshot(store, snapshot(3, NEW_PATH, ['tab-1', 'tab-2'], null))

    expect(worktreeIdsOwningTab(store, 'tab-1')).toEqual([OLD_ID])
    expect(worktreeIdsOwningTab(store, 'tab-2')).toEqual([OLD_ID])
    expect(store.getState().activeTabId).toBeNull()
    expect(store.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]).toMatchObject({
      phase: 'conflict',
      revision: 3
    })
  })
})
