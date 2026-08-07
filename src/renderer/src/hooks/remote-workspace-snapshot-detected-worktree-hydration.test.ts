/**
 * The snapshot apply's replace scope comes from the direct-SSH target scope,
 * which includes detected worktrees; the hydrators re-derive validity from the
 * loaded-worktree catalog only. A worktree known solely through detection sits
 * in the gap: it is in the replace scope, so its current state is replaced, but
 * outside the validity set, so nothing hydrated survives the filter — every
 * sync erases its tabs instead of restoring them. These tests pin the apply to
 * declaring its replace scope valid.
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
const DETECTED_PATH = '/srv/proj/wt-detected'
const DETECTED_ID = `repoA::${DETECTED_PATH}`

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

function snapshot(revision: number, tabIds: readonly string[]): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    session: {
      activeWorktreePath: null,
      activeTabId: null,
      tabsByWorktreePath: {
        [DETECTED_PATH]: tabIds.map((tabId, index) => ({
          id: tabId,
          worktreePath: DETECTED_PATH,
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
      activeTabIdByWorktreePath: {},
      remoteSessionIdsByTabId: Object.fromEntries(tabIds.map((id) => [id, `pty-${id}`])),
      lastVisitedAtByWorktreePath: {},
      defaultTerminalTabsAppliedByWorktreePath: {}
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

function seedDetectedOnlyCatalog(store: TestStore): void {
  store.setState({
    // Why: the worktree is known to detection (authoritative git scan) but not
    // loaded — the exact split between the target scope and hydration validity.
    worktreesByRepo: {},
    detectedWorktreesByRepo: {
      repoA: {
        repoId: 'repoA',
        authoritative: true,
        source: 'git',
        worktrees: [
          makeWorktree({
            id: DETECTED_ID,
            repoId: 'repoA',
            path: DETECTED_PATH,
            hostId: `ssh:${TARGET_ID}`
          } as never)
        ]
      } as never
    }
  })
}

function tabIds(store: TestStore, worktreeId: string): string[] {
  return (store.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
}

describe('direct-SSH snapshot apply, detected-only worktree hydration', () => {
  it('hydrates snapshot tabs for a worktree known only through detection', async () => {
    const store = createTestStore()
    seedDetectedOnlyCatalog(store)

    await applySnapshot(store, snapshot(1, ['tab-r1']))

    expect(tabIds(store, DETECTED_ID)).toEqual(['tab-r1'])
  })

  it('does not erase existing tabs of a detected-only worktree on re-apply', async () => {
    const store = createTestStore()
    seedDetectedOnlyCatalog(store)
    await applySnapshot(store, snapshot(1, ['tab-r1']))
    expect(tabIds(store, DETECTED_ID)).toEqual(['tab-r1'])

    await applySnapshot(store, snapshot(2, ['tab-r1']))

    expect(tabIds(store, DETECTED_ID)).toEqual(['tab-r1'])
  })
})
