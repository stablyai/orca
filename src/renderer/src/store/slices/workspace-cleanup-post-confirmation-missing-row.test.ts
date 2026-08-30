/**
 * The refused-forever case: the rescan the preflight runs no longer lists the
 * workspace the user confirmed, so there is no refreshed row to show in its
 * place. Refusing is right — the removal must not proceed on a workspace the
 * scan cannot vouch for — but leaving the row standing means every later
 * confirmation repeats "Workspace no longer exists" against a picture that can
 * never change. These cases assert the row is reconciled away instead, and that
 * dropping it stays inside the same limit republishing obeys.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
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

/** The rescan answers, and answers that this workspace is not there. */
function installStoreWithScan(
  scanResult: WorkspaceCleanupScanResult,
  listCandidates: WorkspaceCleanupCandidate[] = [makeCandidate()]
) {
  const scan = vi.fn().mockResolvedValue(scanResult)
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
    // The list the user is looking at, exactly as the last completed scan left it.
    workspaceCleanupScan: { scannedAt: NOW, candidates: listCandidates, errors: [] }
  } as Partial<AppState> as AppState)
  const listedRows = (): WorkspaceCleanupCandidate[] =>
    store.getState().workspaceCleanupScan?.candidates ?? []
  return { store, removeWorktree, listedRows }
}

/**
 * An omission from a host that answered. The listing verdict is what makes this
 * absence an answer at all: without it the same empty result is indistinguishable
 * from a host nobody reached, and retiring the row on that would drop a workspace
 * that still exists (see workspace-cleanup-unverifiable-omission.test.ts).
 */
const EMPTY_SCAN: WorkspaceCleanupScanResult = {
  scannedAt: NOW,
  candidates: [],
  errors: [],
  repoListings: [{ repoId: 'repo1', executionHostId: 'local', verdict: 'exited' }]
}

describe('workspace cleanup list after the rescan stops listing a confirmed workspace', () => {
  it('refuses the removal', async () => {
    const { store, removeWorktree } = installStoreWithScan(EMPTY_SCAN)

    const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeCandidate({ blockers: [] })]
    })

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(result.removedIds).toEqual([])
    expect(result.failures).toHaveLength(1)
  })

  it('reconciles the obsolete row away instead of leaving it to be re-confirmed', async () => {
    const { store, listedRows } = installStoreWithScan(EMPTY_SCAN)

    await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeCandidate({ blockers: [] })]
    })

    expect(
      listedRows(),
      'a row the scan no longer lists has no picture left to confirm against'
    ).toEqual([])
  })

  it('leaves other workspaces the rescan did not answer for alone', async () => {
    const other = makeCandidate({ worktreeId: 'repo-1::/tmp/other-workspace' })
    const { store, listedRows } = installStoreWithScan(EMPTY_SCAN, [makeCandidate(), other])

    await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeCandidate({ blockers: [] })]
    })

    expect(listedRows().map((candidate) => candidate.worktreeId)).toEqual([other.worktreeId])
  })

  it('keeps a row a refresh republished while the preflight was still running', async () => {
    // The staleness guard: this row is not the one the preflight was newer than,
    // so it is the newer read and the retirement may not reach it.
    const { store, listedRows } = installStoreWithScan(EMPTY_SCAN)
    const scanApi = window.api.workspaceCleanup.scan as unknown as ReturnType<typeof vi.fn>
    const settledRefreshRow = makeCandidate({ blockers: ['dirty-files'] })
    scanApi.mockImplementation(async () => {
      store.setState({
        workspaceCleanupScan: { scannedAt: NOW + 1, candidates: [settledRefreshRow], errors: [] }
      } as Partial<AppState> as AppState)
      return EMPTY_SCAN
    })

    await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeCandidate({ blockers: [] })]
    })

    expect(listedRows()).toEqual([settledRefreshRow])
  })

  it('does not touch the list when the workspace was never confirmed', async () => {
    // With no approved candidate there is no row this stop can name, and guessing
    // one would drop a row on evidence about a different workspace.
    const { store, listedRows } = installStoreWithScan(EMPTY_SCAN)

    await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID])

    expect(listedRows()).toHaveLength(1)
  })
})
