import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import type { TerminalTab } from '../../../shared/types'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import { applyDirectSshRemoteWorkspaceSnapshot } from './remote-workspace-snapshot-apply'
import type { DirectSshSnapshotApplyToken } from './direct-ssh-reconnect-coordinator-types'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const TARGET_ID = 'target-1'
const WORKTREE_PATH = '/home/atlas-eval'
const WORKTREE_ID = `repo-1::${WORKTREE_PATH}`
const authority: DirectSshAuthority = {
  targetId: TARGET_ID,
  providerEpoch: 'provider-1' as SshProviderEpoch,
  connectionGeneration: 1
}

function tab(id: string, ptyId: string): TerminalTab {
  return {
    id,
    worktreeId: WORKTREE_ID,
    ptyId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function snapshot(tabId: string): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision: 1,
    updatedAt: 1,
    schemaVersion: 1,
    session: {
      activeWorktreePath: WORKTREE_PATH,
      activeTabId: tabId,
      tabsByWorktreePath: {
        [WORKTREE_PATH]: [
          {
            id: tabId,
            worktreePath: WORKTREE_PATH,
            ptyId: `ssh:${TARGET_ID}@@pty-1`,
            title: tabId,
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {},
      activeTabIdByWorktreePath: { [WORKTREE_PATH]: tabId }
    }
  }
}

describe('direct SSH durable PTY recovery', () => {
  it('keeps a bound durable tab when a stale remote snapshot omits it', async () => {
    const store = createTestStore()
    const localTab = tab('tab-claude', `ssh:${TARGET_ID}@@pty-42`)
    store.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/home/repo',
          displayName: 'Repo',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: TARGET_ID
        } as never
      ],
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo-1',
            path: WORKTREE_PATH,
            hostId: `ssh:${TARGET_ID}`
          } as never)
        ]
      },
      activeRepoId: 'repo-1',
      activeWorktreeId: WORKTREE_ID,
      activeTabId: localTab.id,
      activeTabIdByWorktree: { [WORKTREE_ID]: localTab.id },
      tabsByWorktree: { [WORKTREE_ID]: [localTab] },
      pendingReconnectPtyIdByTabId: {},
      reconnectPersistedTerminals: vi.fn(async () => {}),
      markRemoteWorkspaceHydrated: vi.fn(),
      setRemoteWorkspaceSyncStatus: vi.fn()
    })
    const remoteTabId = 'tab-old-shell'
    const token: DirectSshSnapshotApplyToken = {
      authority,
      catalogRevision: 0,
      repoFingerprint: 'fp',
      authorityRequirement: 'required',
      snapshotRevision: 1,
      outcome: 'complete'
    }

    await applyDirectSshRemoteWorkspaceSnapshot({
      store,
      snapshot: snapshot(remoteTabId),
      token,
      arrival: 1,
      isArrivalCurrent: () => true,
      isPreparationTokenCurrent: () => true,
      waitForWorkspaceSessionReady: async () => true,
      finalizeHydratedTerminals: () => 0
    })

    expect(store.getState().tabsByWorktree[WORKTREE_ID].map((entry) => entry.id)).toEqual([
      remoteTabId,
      localTab.id
    ])
    expect(store.getState().activeTabId).toBe(localTab.id)
    // The unified maps drive the rendered tab strip; recovery must reach them too.
    const unified = store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []
    expect(unified.map((entry) => entry.id).sort()).toEqual([remoteTabId, localTab.id].sort())
    const groups = store.getState().groupsByWorktree[WORKTREE_ID] ?? []
    expect(groups.flatMap((group) => group.tabOrder).sort()).toEqual(
      [remoteTabId, localTab.id].sort()
    )
  })
})
