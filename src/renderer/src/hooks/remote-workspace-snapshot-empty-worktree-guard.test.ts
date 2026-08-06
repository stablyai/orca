/**
 * Drives the real snapshot apply against a real store. A pulled snapshot that
 * reports no tabs for a worktree the renderer is showing tabs in must leave that
 * worktree's live terminals untouched, while a worktree the snapshot does carry
 * tabs for still replaces.
 *
 * The merge alone cannot express this: a merge that protects the worktree still
 * loses its live PTY bindings if the worktree stays in the hydration replace
 * scope, so the assertions below read post-apply store state and the scope handed
 * to reconnect rather than the merge result.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import type { TerminalTab } from '../../../shared/types'
import { createTestStore, makeTab, makeWorktree } from '../store/slices/store-test-helpers'
import type { DirectSshSnapshotApplyToken } from './direct-ssh-reconnect-coordinator-types'
import { applyDirectSshRemoteWorkspaceSnapshot } from './remote-workspace-snapshot-apply'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const TARGET_ID = 'target-a'
const REPO_ID = 'repo-a'
const KEPT_PATH = '/remote/work'
const REPLACED_PATH = '/remote/other'
const KEPT_ID = `${REPO_ID}::${KEPT_PATH}`
const REPLACED_ID = `${REPO_ID}::${REPLACED_PATH}`

const authority: DirectSshAuthority = {
  targetId: TARGET_ID,
  providerEpoch: 'epoch-a' as SshProviderEpoch,
  connectionGeneration: 1
}

function ptyId(tabId: string): string {
  return `ssh:${TARGET_ID}@@pty-${tabId}`
}

function liveTab(id: string, worktreeId: string, sortOrder = 0): TerminalTab {
  return makeTab({ id, worktreeId, ptyId: ptyId(id), title: id, sortOrder, createdAt: 1 })
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
  tabsByWorktreePath: RemoteWorkspaceSnapshot['session']['tabsByWorktreePath']
): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision: 1,
    updatedAt: 1,
    schemaVersion: 1,
    session: {
      activeWorktreePath: null,
      activeTabId: null,
      tabsByWorktreePath,
      terminalLayoutsByTabId: {},
      activeWorktreePathsOnShutdown: [],
      activeTabIdByWorktreePath: {},
      remoteSessionIdsByTabId: {},
      lastVisitedAtByWorktreePath: {},
      defaultTerminalTabsAppliedByWorktreePath: {}
    }
  }
}

function remoteTab(worktreePath: string, id: string) {
  return {
    id,
    worktreePath,
    ptyId: ptyId(id),
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function createHarness() {
  const store = createTestStore()
  const reconnectWorkspaceKeys: string[][] = []
  store.setState({
    repos: [
      {
        id: REPO_ID,
        path: '/remote/repo-a',
        displayName: 'Repo A',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: TARGET_ID
      } as never
    ],
    worktreesByRepo: {
      [REPO_ID]: [
        makeWorktree({
          id: KEPT_ID,
          repoId: REPO_ID,
          path: KEPT_PATH,
          hostId: `ssh:${TARGET_ID}`
        } as never),
        makeWorktree({
          id: REPLACED_ID,
          repoId: REPO_ID,
          path: REPLACED_PATH,
          hostId: `ssh:${TARGET_ID}`
        } as never)
      ]
    },
    tabsByWorktree: {
      [KEPT_ID]: [liveTab('tab-kept', KEPT_ID)],
      [REPLACED_ID]: [liveTab('tab-stale', REPLACED_ID)]
    },
    ptyIdsByTabId: { 'tab-kept': [ptyId('tab-kept')], 'tab-stale': [ptyId('tab-stale')] },
    activeWorktreeId: KEPT_ID,
    activeTabId: 'tab-kept',
    activeTabIdByWorktree: { [KEPT_ID]: 'tab-kept' },
    reconnectPersistedTerminals: (async (_signal, options) => {
      reconnectWorkspaceKeys.push([...(options?.workspaceKeys ?? [])])
    }) as never,
    markRemoteWorkspaceHydrated: (() => {}) as never,
    setRemoteWorkspaceSyncStatus: (() => {}) as never
  })
  return { store, reconnectWorkspaceKeys }
}

async function applySnapshot(
  store: ReturnType<typeof createTestStore>,
  snap: RemoteWorkspaceSnapshot
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

describe('direct-SSH snapshot apply, worktree the snapshot reports no tabs for', () => {
  it('leaves the live terminals and the hydration scope alone', async () => {
    const { store, reconnectWorkspaceKeys } = createHarness()

    await applySnapshot(
      store,
      snapshot({
        [KEPT_PATH]: [],
        [REPLACED_PATH]: [remoteTab(REPLACED_PATH, 'tab-remote')]
      })
    )

    const state = store.getState()
    expect(state.tabsByWorktree[KEPT_ID].map((tab) => tab.id)).toEqual(['tab-kept'])
    // Live PTY binding, not a rehydrated placeholder: hydration clears ptyId and arms
    // pendingActivationSpawn for every tab inside the replace scope.
    expect(state.tabsByWorktree[KEPT_ID][0].ptyId).toBe(ptyId('tab-kept'))
    expect(state.tabsByWorktree[KEPT_ID][0].pendingActivationSpawn).toBeUndefined()
    expect(state.ptyIdsByTabId['tab-kept']).toEqual([ptyId('tab-kept')])
    expect(state.pendingReconnectWorktreeIds).not.toContain(KEPT_ID)
    expect(reconnectWorkspaceKeys).toEqual([[REPLACED_ID]])

    // The remote stays authoritative for the worktree it does report tabs for.
    expect(state.tabsByWorktree[REPLACED_ID].map((tab) => tab.id)).toEqual(['tab-remote'])
  })

  it('leaves the live terminals alone when the snapshot omits the worktree entirely', async () => {
    const { store, reconnectWorkspaceKeys } = createHarness()

    await applySnapshot(
      store,
      snapshot({ [REPLACED_PATH]: [remoteTab(REPLACED_PATH, 'tab-remote')] })
    )

    const state = store.getState()
    expect(state.tabsByWorktree[KEPT_ID][0].ptyId).toBe(ptyId('tab-kept'))
    expect(state.ptyIdsByTabId['tab-kept']).toEqual([ptyId('tab-kept')])
    expect(reconnectWorkspaceKeys).toEqual([[REPLACED_ID]])
  })
})
