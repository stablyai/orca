/**
 * Which of two reads of the same row the list ends up showing. A refused removal
 * holds its preflight's rescan; the list may meanwhile be replaced by a refresh
 * that settles behind it. Neither one wins by being the republisher or by being
 * the object currently in the list — the newer read wins, and a scan says how
 * old it is in `scannedAt`.
 *
 * Both directions are pinned here, because they are the same rule: a refresh
 * issued after the rescan keeps its row, and a long broad refresh that started
 * before the confirmation does not bury the rescan's newer verdict.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import { WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT } from '../../../../shared/workspace-cleanup'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  deferred,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

const DIRTY_BUFFER = [
  { id: 'file-1', worktreeId: WORKTREE_ID, path: '/tmp/old-workspace/a.ts', isDirty: true }
] as unknown as AppState['openFiles']

// A broad scan of a real fleet runs for minutes, so the two reads are minutes
// apart in either order depending on when the refresh was issued.
const SCAN_INTERVAL_MS = 5 * 60_000

/**
 * The preflight's terminal probe is the await the refresh lands inside. Enrichment
 * reads store state before it, so a probe held open freezes the preflight's picture
 * of the workspace while the rest of the app moves on.
 */
function installRaceStore() {
  const gate = deferred<{ foregroundProcess: string | null; hasChildProcesses: boolean }>()
  let gated = false
  const gateProbe = <T>(gatedValue: unknown, laterValue: T) =>
    vi.fn(async () => {
      if (gated) {
        return laterValue
      }
      gated = true
      await gate.promise
      return gatedValue as T
    })

  // Call order is the issue order: the removal's rescan, then the refresh the
  // user starts while the preflight's probe is still open.
  const scan = vi
    .fn()
    .mockResolvedValueOnce({ scannedAt: NOW, candidates: [makeCandidate()], errors: [] })
    .mockResolvedValue({
      scannedAt: NOW + SCAN_INTERVAL_MS,
      candidates: [makeCandidate()],
      errors: []
    })
  installWorkspaceCleanupApi(scan, vi.fn().mockResolvedValue(null), {
    inspectProcess: gateProbe(
      { foregroundProcess: 'codex', hasChildProcesses: true },
      { foregroundProcess: 'zsh', hasChildProcesses: false }
    ),
    hasChildProcesses: gateProbe(true, false),
    getForegroundProcess: gateProbe('codex', 'zsh')
  })
  ;(window.api.workspaceCleanup as { cancelScan?: unknown }).cancelScan = vi
    .fn()
    .mockResolvedValue(undefined)

  const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
  const store = createCleanupTestStore(removeWorktree)
  store.setState({
    tabsByWorktree: {
      [WORKTREE_ID]: [{ id: 'tab-1', title: 'zsh' }] as AppState['tabsByWorktree'][string]
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    openFiles: [],
    workspaceCleanupScan: { scannedAt: NOW, candidates: [makeCandidate()], errors: [] }
  } as Partial<AppState> as AppState)

  const listedRow = (): WorkspaceCleanupCandidate | undefined =>
    store.getState().workspaceCleanupScan?.candidates[0]
  return { store, scan, removeWorktree, listedRow, gate, isGated: () => gated }
}

/**
 * The mirror interleaving: a broad refresh issued BEFORE the confirmation, whose
 * host read therefore predates the removal's rescan, settles while that rescan is
 * still in flight. The list ends up holding rows from the older read.
 */
function installOlderRefreshStore() {
  const gate = deferred<WorkspaceCleanupScanResult>()
  let rescanRequested = false
  const scan = vi.fn(async () => {
    if (!rescanRequested) {
      rescanRequested = true
      return gate.promise
    }
    return {
      scannedAt: NOW - SCAN_INTERVAL_MS,
      candidates: [makeCandidate()],
      errors: []
    } satisfies WorkspaceCleanupScanResult
  })
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

  const listedRows = (): WorkspaceCleanupCandidate[] =>
    store.getState().workspaceCleanupScan?.candidates ?? []
  return {
    store,
    removeWorktree,
    listedRows,
    releaseRescan: gate.resolve,
    isRescanRequested: () => rescanRequested
  }
}

describe('workspace cleanup republish against a newer scan', () => {
  it('keeps the refreshed row when a scan settles while the preflight runs', async () => {
    const { store, removeWorktree, listedRow, gate, isGated } = installRaceStore()

    const removal = store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeCandidate({ blockers: [] })]
    })
    await vi.waitFor(() => expect(isGated()).toBe(true))

    // The user goes back to the list, opens a file, and refreshes. Everything
    // below runs through the real scan action, not a hand-written row.
    store.setState({ openFiles: DIRTY_BUFFER } as Partial<AppState> as AppState)
    await store.getState().scanWorkspaceCleanup()
    // Honesty check: without this the assertion below could pass on a row that
    // never carried the verdict.
    expect(listedRow()?.blockers).toContain('dirty-editor-buffer')

    gate.resolve({ foregroundProcess: 'codex', hasChildProcesses: true })
    const result = await removal

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(result.failures).toHaveLength(1)
    expect(listedRow()?.blockers).toContain('dirty-editor-buffer')
  })

  it('publishes the rescan when the refresh that replaced the row read older', async () => {
    const { store, removeWorktree, listedRows, releaseRescan, isRescanRequested } =
      installOlderRefreshStore()

    const removal = store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeCandidate({ blockers: [] })]
    })
    await vi.waitFor(() => expect(isRescanRequested()).toBe(true))

    // The broad refresh that was already running when the user confirmed now
    // settles, replacing every row with output read before the rescan's.
    await store.getState().scanWorkspaceCleanup()
    // Honesty check: the row the refresh published carries no verdict at all, so
    // the assertion below cannot pass on a row that already had one.
    expect(listedRows()[0]?.blockers).toEqual([])

    releaseRescan({
      scannedAt: NOW,
      candidates: [makeCandidate({ blockers: ['dirty-files'] })],
      errors: []
    })
    const result = await removal

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(result.failures).toHaveLength(1)
    expect(listedRows()[0]?.blockers).toContain('dirty-files')
  })

  it('retires the row when the refresh that replaced it read older than the rescan', async () => {
    const { store, listedRows, releaseRescan, isRescanRequested } = installOlderRefreshStore()

    const removal = store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeCandidate({ blockers: [] })]
    })
    await vi.waitFor(() => expect(isRescanRequested()).toBe(true))
    await store.getState().scanWorkspaceCleanup()
    expect(listedRows()).toHaveLength(1)

    // A completed targeted listing that does not name the workspace: it is gone,
    // and the older refresh still showing it is not evidence that it is not.
    releaseRescan({
      scannedAt: NOW,
      candidates: [],
      errors: [],
      repoListings: [{ repoId: 'repo1', executionHostId: 'local', verdict: 'exited' }]
    })
    await removal

    expect(listedRows()).toEqual([])
  })

  it('dates a chunked rescan by its stalest chunk', async () => {
    // Over the batch limit the rescan is several scans, each with its own read
    // time. The picture they add up to is no fresher than the oldest of them, so
    // a late chunk cannot vouch for rows an early one read before the list did.
    const extraIds = Array.from(
      { length: WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT },
      (_, index) => `repo1::/tmp/filler-${index}`
    )
    const approved = [
      makeCandidate({ blockers: [] }),
      ...extraIds.map((worktreeId) =>
        makeCandidate({ worktreeId, path: `/tmp/filler-${worktreeId}`, blockers: [] })
      )
    ]
    const scan = vi
      .fn()
      .mockResolvedValueOnce({
        scannedAt: NOW - SCAN_INTERVAL_MS,
        candidates: [makeCandidate({ blockers: ['dirty-files'] })],
        errors: []
      } satisfies WorkspaceCleanupScanResult)
      .mockResolvedValue({
        scannedAt: NOW + SCAN_INTERVAL_MS,
        candidates: [],
        errors: []
      } satisfies WorkspaceCleanupScanResult)
    installWorkspaceCleanupApi(scan, vi.fn().mockResolvedValue(null), {
      inspectProcess: vi
        .fn()
        .mockResolvedValue({ foregroundProcess: 'zsh', hasChildProcesses: false }),
      hasChildProcesses: vi.fn().mockResolvedValue(false),
      getForegroundProcess: vi.fn().mockResolvedValue('zsh')
    })
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)
    store.setState({
      openFiles: [],
      workspaceCleanupScan: { scannedAt: NOW, candidates: [makeCandidate()], errors: [] }
    } as Partial<AppState> as AppState)

    await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID, ...extraIds], {
      approvedCandidates: approved
    })

    expect(scan.mock.calls.length).toBeGreaterThan(1)
    expect(removeWorktree).not.toHaveBeenCalled()
    expect(store.getState().workspaceCleanupScan?.candidates[0]?.blockers).toEqual([])
  })
})
