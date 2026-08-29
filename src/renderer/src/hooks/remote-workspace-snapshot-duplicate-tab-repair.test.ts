/**
 * A direct-SSH snapshot can retain the same tab under old and new worktree IDs
 * after a path or repo-ID change. This exercises that hydration path and proves
 * active-tab repair converges; it deliberately does not remove the duplicate or
 * reproduce React's scheduler-level #185 throw. See PR #11950 for that evidence.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import { applyDirectSshRemoteWorkspaceSnapshot } from './remote-workspace-snapshot-apply'
import type { DirectSshSnapshotApplyToken } from './direct-ssh-reconnect-coordinator-types'
import { repairActiveTerminalTab } from '../components/terminal/use-active-terminal-repair'

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
// Why a cap and not a while(true): on unfixed code this cycle never terminates.
const MAX_REPAIR_PASSES = 200

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
      activeTabIdByWorktreePath: { [worktreePath]: activeTabId },
      remoteSessionIdsByTabId: Object.fromEntries(tabIds.map((id) => [id, `pty-${id}`])),
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

/**
 * One turn of the loop in Terminal.tsx's active-terminal repair effect:
 * recompute the repaired id from live state, then activate it. Reports how many
 * turns it took to stop and how often `activeTabIdByWorktree` — a declared dep
 * of that effect, so a fresh identity re-runs it — was reallocated.
 */
function runRepairCycle(store: TestStore): {
  converged: boolean
  passes: number
  depIdentityChurn: number
} {
  let passes = 0
  let depIdentityChurn = 0
  for (; passes < MAX_REPAIR_PASSES; passes += 1) {
    const live = store.getState()
    const depsBefore = live.activeTabIdByWorktree
    const repaired = repairActiveTerminalTab({
      activeTabType: 'terminal',
      activeTabId: live.activeTabId,
      activeTabIdByWorktree: live.activeTabIdByWorktree,
      renderedActiveWorktreeId: live.activeWorktreeId,
      setActiveTab: live.setActiveTab,
      tabs: live.activeWorktreeId ? (live.tabsByWorktree[live.activeWorktreeId] ?? []) : []
    })
    if (!repaired) {
      return { converged: true, passes, depIdentityChurn }
    }
    if (store.getState().activeTabIdByWorktree !== depsBefore) {
      depIdentityChurn += 1
    }
  }
  return { converged: false, passes, depIdentityChurn }
}

describe('direct-SSH snapshot apply, tab id owned by two worktrees', () => {
  it('converges the active-terminal repair instead of re-running it forever', async () => {
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
      markRemoteWorkspaceHydrated: (() => {}) as never,
      setRemoteWorkspaceSyncStatus: (() => {}) as never
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

    // Why assert the precondition and not its removal: the fix stops the owner
    // resolver being fooled by the duplicate, it does not remove the duplicate.
    // Pinned so the test cannot pass vacuously if hydration stops producing one.
    expect(worktreeIdsOwningTab(store, 'tab-1')).toEqual([OLD_ID, NEW_ID])
    expect(store.getState().activeTabId).toBeNull()

    const repair = runRepairCycle(store)

    expect(repair.converged).toBe(true)
    expect(repair.passes).toBeLessThanOrEqual(store.getState().tabsByWorktree[NEW_ID].length)
    expect(store.getState().activeTabId).toBe('tab-1')
    const activeGroupId = store.getState().activeGroupIdByWorktree[NEW_ID]
    expect(
      store.getState().groupsByWorktree[NEW_ID].find((group) => group.id === activeGroupId)
        ?.activeTabId
    ).toBe('tab-1')

    // The dep identity settles: re-running the effect body after convergence
    // reallocates nothing, so the effect does not schedule itself again.
    const settled = runRepairCycle(store)
    expect(settled.depIdentityChurn).toBe(0)
    expect(settled.passes).toBe(0)
  })
})
