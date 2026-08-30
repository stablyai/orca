/**
 * The republish against a read the list took LATER than its own — the case a
 * comparison against `scannedAt` cannot see.
 *
 * A streamed progress tick pins `workspaceCleanupScan.scannedAt` to the snapshot's
 * on purpose (the list still mixes rows from the previous read), so it puts rows
 * minutes newer than the whole list's stamp into it. A republish that decided
 * recency from that stamp therefore compared against a time neither row was read
 * at, and won every time. `workspaceCleanupRowReadAt` is what it must compare
 * against instead — which only works because every writer that replaces rows now
 * stamps what it wrote, not just the one that used to.
 *
 * Both halves of the rule are pinned here, because the second does not follow from
 * the first: recency decides a row's CONTENTS, and separately its EXISTENCE. A
 * retirement is a verdict read at a moment like any other, so an older read that
 * did not list a workspace cannot delete the row a newer read says is live. A row
 * the user cannot see at all is worse than one that is out of date.
 *
 * The control arms run the same interleavings with the tick read EARLIER, where
 * the republish must still win in both directions — otherwise "never overwrite"
 * would pass this file just as well as the rule does.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  deferred,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

const SCAN_INTERVAL_MS = 5 * 60_000
/** The list the user is reading: an older snapshot showing a clean row. */
const SNAPSHOT_AT = NOW - SCAN_INTERVAL_MS
/** The removal's own targeted rescan. */
const RESCAN_AT = NOW
/** The streamed tick, read AFTER the rescan — the newest read of the row. */
const LATER_READ_AT = NOW + SCAN_INTERVAL_MS
const EARLIER_READ_AT = SNAPSHOT_AT - SCAN_INTERVAL_MS

const EXITED_LISTING = [
  { repoId: 'repo1', executionHostId: 'local' as const, verdict: 'exited' as const }
]
/** A real terminal for this workspace, so enrichment can find live work on it. */
const LIVE_TERMINAL_STATE = {
  tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1', title: 'zsh' }] },
  ptyIdsByTabId: { 'tab-1': ['pty-1'] }
} as unknown as AppState

function installPtyReads(live: boolean) {
  return {
    inspectProcess: vi.fn().mockResolvedValue({
      foregroundProcess: live ? 'node' : 'zsh',
      hasChildProcesses: live
    }),
    hasChildProcesses: vi.fn().mockResolvedValue(live),
    getForegroundProcess: vi.fn().mockResolvedValue(live ? 'node' : 'zsh')
  }
}

/**
 * One `window.api` serving two scans: the removal's targeted rescan, held open on
 * a gate, and a broad scan that emits a single progress tick and never settles —
 * so the list holds the tick's row while `scannedAt` stays the snapshot's.
 */
function installTickStore({
  tickRow,
  tickAt,
  live = false,
  extraState
}: {
  tickRow: WorkspaceCleanupCandidate
  tickAt: number
  live?: boolean
  extraState?: AppState
}) {
  const rescanGate = deferred<WorkspaceCleanupScanResult>()
  let rescanRequested = false
  const scan = vi.fn(
    async (
      args: { worktreeIds?: readonly string[]; scanId: string },
      onProgress?: (progress: WorkspaceCleanupScanProgress) => void
    ) => {
      if (args.worktreeIds !== undefined) {
        rescanRequested = true
        return rescanGate.promise
      }
      onProgress?.({
        scanId: args.scanId,
        scannedAt: tickAt,
        scannedWorktreeCount: 1,
        totalWorktreeCount: 2,
        candidates: [tickRow],
        errors: []
      })
      return new Promise<WorkspaceCleanupScanResult>(() => {})
    }
  )
  installWorkspaceCleanupApi(scan, vi.fn().mockResolvedValue(null), installPtyReads(live))
  ;(window.api.workspaceCleanup as { cancelScan?: unknown }).cancelScan = vi
    .fn()
    .mockResolvedValue(undefined)

  const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
  const store = createCleanupTestStore(removeWorktree)
  store.setState({
    openFiles: [],
    ...extraState,
    workspaceCleanupScan: {
      scannedAt: SNAPSHOT_AT,
      candidates: [makeCandidate({ blockers: [] })],
      errors: []
    }
  } as Partial<AppState> as AppState)

  const listedRows = (): WorkspaceCleanupCandidate[] =>
    store.getState().workspaceCleanupScan?.candidates ?? []
  return {
    store,
    listedRows,
    removeWorktree,
    releaseRescan: rescanGate.resolve,
    isRescanRequested: () => rescanRequested
  }
}

/**
 * Confirm a clean row, let the rescan open, let the tick land, then answer the
 * rescan. `tickLanded` is the honesty check: without it every assertion below
 * could pass on a tick that never reached the list.
 */
async function driveTickThenRepublish(
  harness: ReturnType<typeof installTickStore>,
  rescan: WorkspaceCleanupScanResult,
  tickLanded: (rows: WorkspaceCleanupCandidate[]) => boolean
): Promise<void> {
  const removal = harness.store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
    approvedCandidates: [makeCandidate({ blockers: [] })]
  })
  await vi.waitFor(() => expect(harness.isRescanRequested()).toBe(true))
  void harness.store.getState().scanWorkspaceCleanup()
  await vi.waitFor(() => expect(tickLanded(harness.listedRows())).toBe(true))
  harness.releaseRescan(rescan)
  await removal
}

const hasBlocker =
  (blocker: string) =>
  (rows: readonly WorkspaceCleanupCandidate[]): boolean =>
    rows[0]?.blockers.includes(blocker as WorkspaceCleanupCandidate['blockers'][number]) === true

describe('workspace cleanup republish against a row read after it', () => {
  it('keeps a blocker a streamed tick read after the rescan', async () => {
    const harness = installTickStore({
      tickRow: makeCandidate({ blockers: ['dirty-files', 'unpushed-commits'] }),
      tickAt: LATER_READ_AT
    })
    await driveTickThenRepublish(
      harness,
      {
        scannedAt: RESCAN_AT,
        candidates: [makeCandidate({ blockers: ['dirty-files'] })],
        errors: []
      },
      hasBlocker('unpushed-commits')
    )

    // The tick's read is the newest one of this row, and `scannedAt` never moved
    // to say so — only the row's own read time can keep it.
    expect(harness.listedRows()[0]?.blockers).toContain('unpushed-commits')
    expect(harness.store.getState().workspaceCleanupScan?.scannedAt).toBe(SNAPSHOT_AT)
  })

  it('keeps a live row a streamed tick read after the rescan omitted it', async () => {
    const harness = installTickStore({
      tickRow: makeCandidate({ blockers: [] }),
      tickAt: LATER_READ_AT,
      live: true,
      extraState: LIVE_TERMINAL_STATE
    })
    await driveTickThenRepublish(
      harness,
      { scannedAt: RESCAN_AT, candidates: [], errors: [], repoListings: EXITED_LISTING },
      hasBlocker('running-terminal')
    )

    // A completed targeted listing, but read before the one that found the
    // workspace running: it is not evidence the workspace is gone.
    expect(harness.listedRows()).toHaveLength(1)
    expect(harness.listedRows()[0]?.blockers).toContain('running-terminal')
  })

  it('rewrites a row a streamed tick read before the rescan', async () => {
    const harness = installTickStore({
      tickRow: makeCandidate({ blockers: ['dirty-files'] }),
      tickAt: EARLIER_READ_AT
    })
    await driveTickThenRepublish(
      harness,
      {
        scannedAt: RESCAN_AT,
        candidates: [makeCandidate({ blockers: ['dirty-files', 'unpushed-commits'] })],
        errors: []
      },
      hasBlocker('dirty-files')
    )

    expect(harness.listedRows()[0]?.blockers).toContain('unpushed-commits')
  })

  it('retires a row a streamed tick read before the rescan', async () => {
    const harness = installTickStore({
      tickRow: makeCandidate({ blockers: [] }),
      tickAt: EARLIER_READ_AT,
      live: true,
      extraState: LIVE_TERMINAL_STATE
    })
    await driveTickThenRepublish(
      harness,
      { scannedAt: RESCAN_AT, candidates: [], errors: [], repoListings: EXITED_LISTING },
      hasBlocker('running-terminal')
    )

    expect(harness.listedRows()).toEqual([])
  })

  it('keeps the newer of two refusals when a second removal read older', async () => {
    // Two removals overlapping in the same list: the first refuses on a read the
    // second's rescan predates. Nothing here moves `scannedAt`, so the second
    // republish is held off only by what the first one stamped on the row.
    const scan = vi
      .fn()
      .mockResolvedValueOnce({
        scannedAt: LATER_READ_AT,
        candidates: [makeCandidate({ blockers: ['dirty-files'] })],
        errors: []
      } satisfies WorkspaceCleanupScanResult)
      .mockResolvedValue({
        scannedAt: RESCAN_AT,
        candidates: [makeCandidate({ blockers: ['unpushed-commits'] })],
        errors: []
      } satisfies WorkspaceCleanupScanResult)
    installWorkspaceCleanupApi(scan, vi.fn().mockResolvedValue(null), installPtyReads(false))
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)
    store.setState({
      openFiles: [],
      workspaceCleanupScan: {
        scannedAt: SNAPSHOT_AT,
        candidates: [makeCandidate({ blockers: [] })],
        errors: []
      }
    } as Partial<AppState> as AppState)
    const approved = { approvedCandidates: [makeCandidate({ blockers: [] })] }

    await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], approved)
    // Honesty check: the first refusal really did publish its row.
    expect(store.getState().workspaceCleanupScan?.candidates[0]?.blockers).toContain('dirty-files')

    await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], approved)

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(store.getState().workspaceCleanupScan?.candidates[0]?.blockers).toContain('dirty-files')
  })
})
