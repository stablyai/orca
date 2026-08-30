/**
 * The interleaving the other staleness tests do not reach: the removal's rescan
 * publishes FIRST, and a broad refresh that was already running -- whose host read
 * therefore predates the rescan -- settles AFTER it.
 *
 * The republish compares `scannedAt` before it writes. The broad scan does not
 * compare anything: it replaces the whole list with its own result. So the older
 * read lands last and the blocker the user has not seen yet is erased, leaving the
 * obvious next move (confirm again) to re-run the identical refusal.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { WorkspaceCleanupScanResult } from '../../../../shared/workspace-cleanup'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  deferred,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

const SCAN_INTERVAL_MS = 5 * 60_000

function installBroadRefreshStore() {
  const gate = deferred<WorkspaceCleanupScanResult>()
  let broadRequested = false
  let emitProgress: ((progress: unknown) => void) | null = null
  const scan = vi.fn(
    async (
      args: { worktreeIds?: readonly string[]; scanId?: string },
      onProgress?: (progress: unknown) => void
    ) => {
      // The preflight names its targets; the broad refresh does not.
      if (!args?.worktreeIds) {
        broadRequested = true
        emitProgress = (progress) => onProgress?.(progress)
        return gate.promise
      }
      return {
        scannedAt: NOW,
        candidates: [makeCandidate({ blockers: ['dirty-files'] })],
        errors: []
      } satisfies WorkspaceCleanupScanResult
    }
  )
  installWorkspaceCleanupApi(scan, vi.fn().mockResolvedValue(null), {
    inspectProcess: vi
      .fn()
      .mockResolvedValue({ foregroundProcess: 'zsh', hasChildProcesses: false }),
    hasChildProcesses: vi.fn().mockResolvedValue(false),
    getForegroundProcess: vi.fn().mockResolvedValue('zsh')
  })
  ;(window.api.workspaceCleanup as { cancelScan?: unknown }).cancelScan = vi
    .fn()
    .mockResolvedValue(undefined)

  const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
  const store = createCleanupTestStore(removeWorktree)
  store.setState({
    openFiles: [],
    workspaceCleanupScan: {
      scannedAt: NOW - SCAN_INTERVAL_MS,
      candidates: [makeCandidate()],
      errors: []
    }
  } as Partial<AppState> as AppState)

  const listedRows = () => store.getState().workspaceCleanupScan?.candidates ?? []
  return {
    store,
    removeWorktree,
    listedRows,
    releaseBroadScan: gate.resolve,
    isBroadRequested: () => broadRequested,
    emitBroadProgress: (progress: unknown) => emitProgress?.(progress)
  }
}

describe('workspace cleanup broad refresh against a newer republish', () => {
  it('does not let an older broad refresh erase the blocker the rescan just published', async () => {
    const { store, removeWorktree, listedRows, releaseBroadScan, isBroadRequested } =
      installBroadRefreshStore()

    // Issued before the confirmation, still in flight.
    const broadRefresh = store.getState().scanWorkspaceCleanup()
    await vi.waitFor(() => expect(isBroadRequested()).toBe(true))

    const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeCandidate({ blockers: [] })]
    })

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(result.failures).toHaveLength(1)
    // Honesty check: the rescan's verdict really is on the row before the refresh lands.
    expect(listedRows()[0]?.blockers).toContain('dirty-files')
    // The corollary: the list now shows a row read at NOW, but the scan it lives in still
    // reports the OLDER read as its `scannedAt` -- a per-scan stamp cannot date a per-row read.
    expect(store.getState().workspaceCleanupScan?.scannedAt).toBe(NOW - SCAN_INTERVAL_MS)

    releaseBroadScan({
      scannedAt: NOW - SCAN_INTERVAL_MS,
      candidates: [makeCandidate()],
      errors: []
    })
    await broadRefresh

    expect(listedRows()[0]?.blockers).toContain('dirty-files')
  })

  // The settle is not the only writer that replaces rows: a broad scan STREAMS, and each
  // tick merges into the same list. A tick carrying the older read lands long before the
  // settle does, so the guard has to hold at the tick too.
  it('does not let an older broad progress tick erase the blocker the rescan published', async () => {
    const { store, listedRows, releaseBroadScan, isBroadRequested, emitBroadProgress } =
      installBroadRefreshStore()

    const broadRefresh = store.getState().scanWorkspaceCleanup()
    await vi.waitFor(() => expect(isBroadRequested()).toBe(true))

    await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeCandidate({ blockers: [] })]
    })
    expect(listedRows()[0]?.blockers).toContain('dirty-files')

    emitBroadProgress({
      scanId: 'broad-scan',
      scannedAt: NOW - SCAN_INTERVAL_MS,
      candidates: [makeCandidate()],
      errors: [],
      scannedWorktreeCount: 1,
      totalWorktreeCount: 1
    })
    // Observed BEFORE the settle, so this pins the tick's own guard rather than the settle's.
    await vi.waitFor(() =>
      expect(store.getState().workspaceCleanupProgress?.scanId).toBe('broad-scan')
    )
    expect(listedRows()[0]?.blockers).toContain('dirty-files')

    releaseBroadScan({
      scannedAt: NOW - SCAN_INTERVAL_MS,
      candidates: [makeCandidate()],
      errors: []
    })
    await broadRefresh
  })
})
