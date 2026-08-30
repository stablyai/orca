/**
 * The rescan can come back without a workspace for two entirely different
 * reasons: the host listed its workspaces and this one is not among them, or the
 * host was never reached. Only the first is evidence. `docs/reference/
 * ssh-execution-boundary.md` is binding here — loss of contact is never proof of
 * anything — so a row may only be retired on a listing that actually happened.
 *
 * Every case drives the real removal flow and asserts on the row the user is
 * looking at, never on an intermediate verdict.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import {
  NOW,
  createCleanupTestStore,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

const SSH_WORKTREE_ID = 'repo1::/remote/old-workspace'
const SSH_HOST = 'ssh:host-1'

/** The confirmed row: a workspace on a remote host, shown as removable. */
function sshCandidate(overrides: Partial<WorkspaceCleanupCandidate> = {}) {
  return makeCandidate({
    worktreeId: SSH_WORKTREE_ID,
    executionHostId: SSH_HOST,
    connectionId: 'ssh-1',
    path: '/remote/old-workspace',
    blockers: [],
    ...overrides
  })
}

function installStoreWithScan(scanResult: WorkspaceCleanupScanResult) {
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
    workspaceCleanupScan: { scannedAt: NOW, candidates: [sshCandidate()], errors: [] }
  } as Partial<AppState> as AppState)
  return {
    store,
    removeWorktree,
    listedRows: (): WorkspaceCleanupCandidate[] =>
      store.getState().workspaceCleanupScan?.candidates ?? []
  }
}

async function confirmRemoval(store: ReturnType<typeof installStoreWithScan>['store']) {
  return store.getState().removeWorkspaceCleanupCandidates([SSH_WORKTREE_ID], {
    approvedCandidates: [sshCandidate()]
  })
}

/**
 * Byte-for-byte what `scanWorkspaceCleanup` returns for a targeted scan of a
 * disconnected SSH repo whose persisted host metadata is unavailable: the
 * synthesizer produces no candidate and that branch returns `errors: []`.
 */
const UNREACHABLE_HOST_SCAN: WorkspaceCleanupScanResult = {
  scannedAt: NOW,
  candidates: [],
  errors: [],
  repoListings: [{ repoId: 'repo1', executionHostId: SSH_HOST, verdict: 'unverifiable' }]
}

/** The same omission from a host that answered: the workspace really is gone. */
const HOST_ANSWERED_SCAN: WorkspaceCleanupScanResult = {
  scannedAt: NOW,
  candidates: [],
  errors: [],
  repoListings: [{ repoId: 'repo1', executionHostId: SSH_HOST, verdict: 'exited' }]
}

/** An older host that publishes no listings at all — it has told us nothing. */
const NO_LISTINGS_SCAN: WorkspaceCleanupScanResult = {
  scannedAt: NOW,
  candidates: [],
  errors: []
}

describe('a rescan omission from a host that was never reached', () => {
  it('keeps the row instead of retiring it', async () => {
    const { store, listedRows } = installStoreWithScan(UNREACHABLE_HOST_SCAN)

    await confirmRemoval(store)

    expect(
      listedRows().map((row) => row.worktreeId),
      'an unreachable host has said nothing about whether this workspace still exists'
    ).toEqual([SSH_WORKTREE_ID])
  })

  it('does not tell the user the workspace no longer exists', async () => {
    const { store } = installStoreWithScan(UNREACHABLE_HOST_SCAN)

    const result = await confirmRemoval(store)

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.message).not.toContain('no longer exists')
  })

  it('still refuses the removal', async () => {
    const { store, removeWorktree } = installStoreWithScan(UNREACHABLE_HOST_SCAN)

    const result = await confirmRemoval(store)

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(result.removedIds).toEqual([])
  })

  it('keeps the row when the host publishes no listings at all', async () => {
    // A host older than the field cannot distinguish the two cases either, and
    // retiring on that ambiguity is the bug.
    const { store, listedRows } = installStoreWithScan(NO_LISTINGS_SCAN)

    await confirmRemoval(store)

    expect(listedRows().map((row) => row.worktreeId)).toEqual([SSH_WORKTREE_ID])
  })

  it('keeps the row when another host answered but this one did not', async () => {
    // A listing for a different host of the same repo is evidence about that
    // host's checkout, not this one's.
    const { store, listedRows } = installStoreWithScan({
      ...NO_LISTINGS_SCAN,
      repoListings: [{ repoId: 'repo1', executionHostId: 'local', verdict: 'exited' }]
    })

    await confirmRemoval(store)

    expect(listedRows().map((row) => row.worktreeId)).toEqual([SSH_WORKTREE_ID])
  })

  it('keeps the row when only a different repo was listed', async () => {
    // A sibling repo's completed listing says nothing about this repo's host.
    const { store, listedRows } = installStoreWithScan({
      ...NO_LISTINGS_SCAN,
      repoListings: [{ repoId: 'repo-other', executionHostId: SSH_HOST, verdict: 'exited' }]
    })

    await confirmRemoval(store)

    expect(listedRows().map((row) => row.worktreeId)).toEqual([SSH_WORKTREE_ID])
  })

  it('will not call an unqualified row gone while one of its possible hosts is out of contact', async () => {
    // A legacy caller passes no confirmation, so the target names no host and
    // every host that owns the repo could be the one holding this workspace.
    // One of them answering is not the same as all of them answering.
    const { store } = installStoreWithScan({
      ...NO_LISTINGS_SCAN,
      repoListings: [
        { repoId: 'repo1', executionHostId: 'local', verdict: 'exited' },
        { repoId: 'repo1', executionHostId: SSH_HOST, verdict: 'unverifiable' }
      ]
    })

    const result = await store.getState().removeWorkspaceCleanupCandidates([SSH_WORKTREE_ID])

    expect(result.failures[0]?.message).not.toContain('no longer exists')
  })

  it('does call an unqualified row gone once every host that could hold it answered', async () => {
    // Polarity control for the case above: with no host left unheard, the honest
    // statement is that the workspace is gone, not that Orca could not look.
    const { store } = installStoreWithScan({
      ...NO_LISTINGS_SCAN,
      repoListings: [
        { repoId: 'repo1', executionHostId: 'local', verdict: 'exited' },
        { repoId: 'repo1', executionHostId: SSH_HOST, verdict: 'exited' }
      ]
    })

    const result = await store.getState().removeWorkspaceCleanupCandidates([SSH_WORKTREE_ID])

    expect(result.failures[0]?.message).toContain('no longer exists')
  })

  it('still retires the row when the host listed its workspaces and this one was gone', async () => {
    // Polarity control: the reconciliation this PR added must survive the fence.
    const { store, listedRows } = installStoreWithScan(HOST_ANSWERED_SCAN)

    const result = await confirmRemoval(store)

    expect(listedRows()).toEqual([])
    expect(result.failures[0]?.message).toContain('no longer exists')
  })
})
