/**
 * Drives the real apply path with the real session writer wired exactly as the app wires it.
 *
 * The write gate closes for the whole apply plus a 1s suppression tail that expires on a wall
 * clock — no store update follows it. So a tab the user closes on an unrelated target during
 * target A's reconnect has to be held and written when the tail ends, or the close and its
 * tombstone are lost until the next unrelated mutation (a crash or kill in between loses both).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RemoteWorkspaceObservedSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import {
  createSessionWriteSubscriber,
  type WorkspaceSessionWrite
} from '../lib/session-write-subscriber'
import {
  applyDirectSshRemoteWorkspaceSnapshot,
  isDirectSshRemoteWorkspaceApplyInProgress,
  onDirectSshRemoteWorkspaceApplyWindowClosed
} from './remote-workspace-snapshot-apply'
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

const TARGET_A = 'ssh-target-a'
const PATH_A = '/srv/proj/target-a'
const WORKTREE_A = `repoA::${PATH_A}`
const WORKTREE_B = 'repoB::/srv/other/target-b'

const authority: DirectSshAuthority = {
  targetId: TARGET_A,
  providerEpoch: 'provider-epoch-1' as SshProviderEpoch,
  connectionGeneration: 1
}

type TestStore = ReturnType<typeof createTestStore>

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

function snapshot(revision: number): RemoteWorkspaceObservedSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    hostObservationToken: `observation-${revision}`,
    session: {
      activeWorktreePath: PATH_A,
      activeTabId: 'tab-a',
      tabsByWorktreePath: {
        [PATH_A]: [
          {
            id: 'tab-a',
            worktreePath: PATH_A,
            ptyId: 'pty-tab-a',
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {},
      activeWorktreePathsOnShutdown: [],
      activeTabIdByWorktreePath: { [PATH_A]: 'tab-a' },
      remoteSessionIdsByTabId: { 'tab-a': 'pty-tab-a' },
      lastVisitedAtByWorktreePath: { [PATH_A]: revision },
      defaultTerminalTabsAppliedByWorktreePath: { [PATH_A]: true }
    }
  } satisfies RemoteWorkspaceObservedSnapshot
}

function seedCatalog(store: TestStore): void {
  store.setState({
    worktreesByRepo: {
      repoA: [
        makeWorktree({
          id: WORKTREE_A,
          repoId: 'repoA',
          path: PATH_A,
          hostId: `ssh:${TARGET_A}`
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
        connectionId: TARGET_A
      } as never
    ],
    reconnectPersistedTerminals: (async () => {}) as never,
    markRemoteWorkspaceHydrated: (() => {}) as never,
    setRemoteWorkspaceSyncStatus: (() => {}) as never
  })
}

/** A second target's tab the user closes while target A is mid-apply. */
function closeUnrelatedTargetTab(store: TestStore): void {
  store.setState({
    tabsByWorktree: { ...store.getState().tabsByWorktree, [WORKTREE_B]: [] },
    closedTerminalTabTombstonesByTabId: {
      'tab-b': { closedAt: Date.now(), worktreeId: WORKTREE_B }
    }
  })
}

/** Everything here is timer-driven, so fake timers make the tail deterministic and instant. */
describe('session writes deferred by a direct-SSH apply', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function applyTargetA(store: TestStore, onApplied: () => void): Promise<void> {
    await applyDirectSshRemoteWorkspaceSnapshot({
      store,
      snapshot: snapshot(1),
      token: token(1),
      arrival: 1,
      isArrivalCurrent: () => true,
      isPreparationTokenCurrent: () => true,
      waitForWorkspaceSessionReady: async () => true,
      // Runs inside the apply, which is when the write gate is shut.
      finalizeHydratedTerminals: () => {
        onApplied()
        return 0
      }
    })
  }

  function seedBothTargets(store: TestStore): void {
    seedCatalog(store)
    store.setState({
      tabsByWorktree: {
        [WORKTREE_B]: [
          {
            id: 'tab-b',
            ptyId: 'pty-tab-b',
            worktreeId: WORKTREE_B,
            title: 'Other host',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          } as never
        ]
      }
    })
  }

  it('lands an unrelated target\u2019s tab close once the suppression tail expires', async () => {
    const store = createTestStore()
    seedBothTargets(store)

    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({
      store,
      persist,
      shouldSchedulePersist: () => !isDirectSshRemoteWorkspaceApplyInProgress(),
      subscribeToPersistGateOpen: onDirectSshRemoteWorkspaceApplyWindowClosed
    })
    try {
      store.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
      vi.advanceTimersByTime(200)
      expect(persist).toHaveBeenCalled()
      persist.mockClear()

      await applyTargetA(store, () => closeUnrelatedTargetTab(store))

      expect(
        isDirectSshRemoteWorkspaceApplyInProgress(),
        'the suppression tail should still be holding writes here'
      ).toBe(true)
      expect(persist).not.toHaveBeenCalled()

      // Tail (1000ms) + the notice's 1ms margin + the writer's 150ms debounce.
      vi.advanceTimersByTime(1_200)

      expect(persist, 'the close made during the apply never reached disk').toHaveBeenCalledTimes(1)
      const patch = persist.mock.calls[0][0].patch
      expect(patch.closedTerminalTabTombstonesByTabId?.['tab-b']?.worktreeId).toBe(WORKTREE_B)
      expect(patch.tabsByWorktree?.[WORKTREE_B]).toEqual([])
      expect(patch.tabsByWorktree?.[WORKTREE_A]).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('still wakes the deferred write when the wall clock steps back during the tail', async () => {
    const store = createTestStore()
    seedBothTargets(store)
    const startedAt = Date.now()

    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({
      store,
      persist,
      shouldSchedulePersist: () => !isDirectSshRemoteWorkspaceApplyInProgress(),
      subscribeToPersistGateOpen: onDirectSshRemoteWorkspaceApplyWindowClosed
    })
    try {
      store.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
      vi.advanceTimersByTime(200)
      persist.mockClear()

      await applyTargetA(store, () => closeUnrelatedTargetTab(store))

      // The notice's delay is wall-clock arithmetic on a monotonic timer, so an NTP step back
      // leaves the deadline in the future when it fires. It must wait, not give up.
      vi.setSystemTime(startedAt - 5_000)
      vi.advanceTimersByTime(1_200)
      expect(persist, 'the notice fired before its own deadline').not.toHaveBeenCalled()

      vi.advanceTimersByTime(5_200)

      expect(persist, 'a clock step back stranded the deferred write').toHaveBeenCalledTimes(1)
      expect(
        persist.mock.calls[0][0].patch.closedTerminalTabTombstonesByTabId?.['tab-b']
      ).toBeDefined()
    } finally {
      cleanup()
    }
  })
})
