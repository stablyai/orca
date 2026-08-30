/**
 * A stopped removal reads its verdict off a rescan that only the preflight sees.
 * If that rescan is never published, the row keeps showing the picture the user
 * already confirmed against, so the obvious next move — confirm it again —
 * re-runs the identical stop. These cases assert what the list shows after a
 * stop, and that the row it now shows is the one a second confirmation is
 * judged against.
 *
 * Publishing is disclosure, not consent: the stale confirmation stays refused
 * (`does not re-authorize` below), and each verdict keeps its own wording.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { WORKSPACE_CLEANUP_CLASSIFIER_VERSION } from '../../../../shared/workspace-cleanup'
import type {
  WorkspaceCleanupBlocker,
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

type PtyInspection = { foregroundProcess: string | null; hasChildProcesses: boolean }

type RefreshArm = {
  blocker: WorkspaceCleanupBlocker
  summary: string
  /** `null` drives an unreachable host: every probe rejects, so liveness is unverifiable. */
  inspection: PtyInspection | null
  tabTitle: string
  openFiles?: AppState['openFiles']
}

const IDLE_SHELL: PtyInspection = { foregroundProcess: 'zsh', hasChildProcesses: false }

const REFRESH_ARMS: RefreshArm[] = [
  {
    blocker: 'dirty-editor-buffer',
    summary: 'an editor buffer holds unsaved text',
    inspection: IDLE_SHELL,
    tabTitle: 'zsh',
    openFiles: [
      { id: 'file-1', worktreeId: WORKTREE_ID, path: '/tmp/old-workspace/a.ts', isDirty: true }
    ] as unknown as AppState['openFiles']
  },
  {
    blocker: 'running-terminal',
    summary: 'a terminal is running',
    inspection: { foregroundProcess: 'codex', hasChildProcesses: true },
    tabTitle: 'zsh'
  },
  {
    blocker: 'live-agent',
    summary: 'an agent is live',
    inspection: IDLE_SHELL,
    tabTitle: '⠋ Claude working'
  },
  {
    blocker: 'terminal-liveness-unknown',
    summary: 'terminal liveness is unverifiable',
    inspection: null,
    tabTitle: 'zsh'
  }
]

function installStoreFor(arm: RefreshArm, listCandidates = [makeCandidate()]) {
  // The rescan replays the same clean row the list holds; the verdict below is
  // recomputed locally by preflight enrichment.
  const scan = vi.fn().mockResolvedValue({
    scannedAt: NOW,
    candidates: [makeCandidate()],
    errors: []
  } satisfies WorkspaceCleanupScanResult)
  const probe = <T>(value: T): ReturnType<typeof vi.fn> =>
    arm.inspection
      ? vi.fn().mockResolvedValue(value)
      : vi.fn().mockRejectedValue(new Error('host unreachable'))
  installWorkspaceCleanupApi(scan, vi.fn().mockResolvedValue(null), {
    inspectProcess: probe(arm.inspection),
    hasChildProcesses: probe(arm.inspection?.hasChildProcesses ?? false),
    getForegroundProcess: probe(arm.inspection?.foregroundProcess ?? null)
  })
  const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
  const store = createCleanupTestStore(removeWorktree)
  store.setState({
    tabsByWorktree: {
      [WORKTREE_ID]: [{ id: 'tab-1', title: arm.tabTitle }] as AppState['tabsByWorktree'][string]
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    ...(arm.openFiles ? { openFiles: arm.openFiles } : {}),
    // The list the user is looking at, exactly as the last completed scan left it.
    workspaceCleanupScan: { scannedAt: NOW, candidates: listCandidates, errors: [] }
  } as Partial<AppState> as AppState)
  const listedRow = (): WorkspaceCleanupCandidate | undefined =>
    store.getState().workspaceCleanupScan?.candidates[0]
  return { store, removeWorktree, listedRow }
}

describe('workspace cleanup list after a post-confirmation stop', () => {
  for (const arm of REFRESH_ARMS) {
    it(`shows ${arm.blocker} on the row once the preflight finds ${arm.summary}`, async () => {
      const { store, removeWorktree, listedRow } = installStoreFor(arm)

      const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: [makeCandidate({ blockers: [] })]
      })

      expect(removeWorktree).not.toHaveBeenCalled()
      expect(result.failures).toHaveLength(1)
      // What the user now sees on the row they were just refused.
      expect(listedRow()?.blockers).toContain(arm.blocker)
    })

    it(`lets the user delete after confirming the republished row showing ${arm.blocker}`, async () => {
      const { store, removeWorktree, listedRow } = installStoreFor(arm)

      const first = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: [makeCandidate({ blockers: [] })]
      })
      expect(first.removedIds).toEqual([])

      // The user's next move: confirm the row as it now reads.
      const republished = listedRow()
      const second = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: republished ? [republished] : []
      })

      expect(removeWorktree).toHaveBeenCalledTimes(1)
      expect(second.removedIds).toEqual([WORKTREE_ID])
      expect(second.failures).toEqual([])
    })

    it(`does not re-authorize the stale confirmation after republishing ${arm.blocker}`, async () => {
      const { store, removeWorktree } = installStoreFor(arm)
      const staleConfirmation = makeCandidate({ blockers: [] })

      await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: [staleConfirmation]
      })
      const second = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: [staleConfirmation]
      })

      // Refreshing the row is disclosure; only a confirmation given against the
      // refreshed row is consent.
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(second.removedIds).toEqual([])
      expect(second.failures).toHaveLength(1)
    })
  }

  it('keeps a dismissed row hidden after republishing it', async () => {
    const arm = REFRESH_ARMS[1]
    const { store, listedRow } = installStoreFor(arm)
    store.setState({
      workspaceCleanupDismissals: {
        [`local\0${WORKTREE_ID}`]: {
          worktreeId: WORKTREE_ID,
          executionHostId: 'local',
          dismissedAt: NOW,
          fingerprint: 'fingerprint-1',
          classifierVersion: WORKSPACE_CLEANUP_CLASSIFIER_VERSION
        }
      }
    } as Partial<AppState> as AppState)

    await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeCandidate({ blockers: [] })]
    })

    // The preflight enriches without dismissals so a dismissed row stays
    // removable; publishing it must not un-hide it.
    expect(listedRow()?.blockers).toContain('dismissed')
  })

  it('does not add a row the list was not already showing', async () => {
    const arm = REFRESH_ARMS[1]
    const other = makeCandidate({ worktreeId: 'repo1::/tmp/other', path: '/tmp/other' })
    const { store } = installStoreFor(arm, [other])

    await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeCandidate({ blockers: [] })]
    })

    expect(store.getState().workspaceCleanupScan?.candidates).toEqual([other])
  })
})
