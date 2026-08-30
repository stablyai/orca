/**
 * The removal preflight rescans and re-enriches every confirmed row, so it
 * recomputes `running-terminal`, `live-agent` and `terminal-liveness-unknown`
 * between the user's confirmation and the delete. A verdict the confirmed row
 * never carried used to be dropped on the floor: the workspace was removed with
 * no disclosure. A confirmation given against an idle picture is not consent to
 * delete a workspace the preflight no longer reads as idle.
 *
 * Every case here asserts the outcome the user sees — the workspace still
 * existing (`removeWorktree` never called) and a failure row explaining why —
 * never an intermediate blocker field.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupBlocker,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import {
  buildPtyProcessInspectionWireResult,
  type PtyProcessInspectionEvidence
} from '../../../../shared/pty-process-inspection-evidence'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

type PtyInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  processEvidence?: PtyProcessInspectionEvidence
}

type LivenessArm = {
  blocker: WorkspaceCleanupBlocker
  summary: string
  message: string
  /** `null` drives an unreachable host: every probe rejects, so liveness is unverifiable. */
  inspection: PtyInspection | null
  tabTitle: string
}

/**
 * The host OBSERVED an idle shell and said so, so the live-agent arms isolate the
 * agent signal. The same two legacy values with no `processEvidence` are what a
 * pre-v27 daemon publishes for a degraded read, and that is `terminal-liveness-\
 * unknown` — a second blocker, which would make these arms test the wrong thing.
 */
const IDLE_SHELL: PtyInspection = buildPtyProcessInspectionWireResult(
  { verdict: 'observed', processName: 'zsh' },
  { verdict: 'exited' }
)

const LIVENESS_ARMS: LivenessArm[] = [
  {
    blocker: 'running-terminal',
    summary: 'a terminal is running',
    message: 'A terminal or agent in this workspace is running. Review it before removing.',
    inspection: { foregroundProcess: 'codex', hasChildProcesses: true },
    tabTitle: 'zsh'
  },
  {
    blocker: 'live-agent',
    summary: 'an agent is live',
    message: 'A terminal or agent in this workspace is running. Review it before removing.',
    inspection: IDLE_SHELL,
    tabTitle: '⠋ Claude working'
  },
  {
    blocker: 'terminal-liveness-unknown',
    summary: 'terminal liveness is unverifiable',
    message: "Orca cannot verify this workspace's terminals. Review it before removing.",
    inspection: null,
    tabTitle: 'zsh'
  }
]

function installStoreFor(arm: LivenessArm, approvedBlockers: WorkspaceCleanupBlocker[]) {
  // The rescan replays the same clean row main published; every liveness
  // verdict below is recomputed locally by preflight enrichment.
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
    ptyIdsByTabId: { 'tab-1': ['pty-1'] }
  } as Partial<AppState> as AppState)
  return { store, removeWorktree, approvedCandidate: makeCandidate({ blockers: approvedBlockers }) }
}

describe('workspace cleanup removal after a post-confirmation liveness change', () => {
  for (const arm of LIVENESS_ARMS) {
    it(`keeps the workspace and tells the user when the preflight finds ${arm.summary}`, async () => {
      const { store, removeWorktree, approvedCandidate } = installStoreFor(arm, [])

      const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: [approvedCandidate]
      })

      // The outcome the user sees: the workspace survives, and the summary says why.
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(result.removedIds).toEqual([])
      expect(result.failures).toEqual([
        {
          worktreeId: WORKTREE_ID,
          executionHostId: 'local',
          displayName: 'old-workspace',
          message: arm.message
        }
      ])
    })

    it(`still removes the workspace when the user confirmed a row already showing ${arm.blocker}`, async () => {
      const { store, removeWorktree, approvedCandidate } = installStoreFor(arm, [arm.blocker])

      const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: [approvedCandidate]
      })

      // Consent given against this exact verdict is still consent.
      expect(removeWorktree).toHaveBeenCalledTimes(1)
      expect(result.removedIds).toEqual([WORKTREE_ID])
      expect(result.failures).toEqual([])
    })
  }
})
