import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceCleanupScanResult } from '../../../../shared/workspace-cleanup/workspace-cleanup'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  deferred,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

describe('workspace cleanup removal verification and consent', () => {
  it('scopes repo-level scan failures to their execution host', async () => {
    const local = makeCandidate({ executionHostId: 'local' })
    const remote = makeCandidate({
      executionHostId: 'ssh:remote',
      displayName: 'remote'
    })
    installWorkspaceCleanupApi(
      vi.fn().mockResolvedValue({
        scannedAt: NOW,
        candidates: [local],
        errors: [
          {
            repoId: local.repoId,
            repoName: local.repoName,
            executionHostId: 'ssh:remote',
            message: 'Git could not list worktrees.'
          }
        ]
      })
    )
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)

    const result = await store
      .getState()
      .removeWorkspaceCleanupCandidates([WORKTREE_ID, WORKTREE_ID], {
        approvedCandidates: [local, remote]
      })

    expect(result.removedIdentities).toEqual([getWorkspaceCleanupCandidateIdentity(local)])
    expect(result.failures).toEqual([
      expect.objectContaining({
        executionHostId: 'ssh:remote',
        displayName: 'remote'
      })
    ])
    expect(removeWorktree).toHaveBeenCalledTimes(1)
  })

  it('honors one matching unverified-removal consent and rejects its replay', async () => {
    const candidate = makeCandidate({
      executionHostId: 'local',
      blockers: ['git-status-error'],
      git: {
        clean: null,
        upstreamAhead: null,
        upstreamBehind: null,
        checkedAt: null
      }
    })
    installWorkspaceCleanupApi(
      vi.fn().mockResolvedValue({
        scannedAt: NOW,
        candidates: [candidate],
        errors: []
      })
    )
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)
    const identity = getWorkspaceCleanupCandidateIdentity(candidate)
    const attemptId = store.getState().beginUnverifiedRemovalConsent(identity)
    expect(attemptId).toEqual(expect.any(String))
    expect(store.getState().beginUnverifiedRemovalConsent(identity)).toBeNull()

    const first = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [candidate],
      unverifiedRemovalConsent: { identity, attemptId: attemptId! }
    })
    const replay = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [candidate],
      unverifiedRemovalConsent: { identity, attemptId: attemptId! }
    })

    expect(first.removedIdentities).toEqual([identity])
    expect(replay.failures).toEqual([expect.objectContaining({ canDeleteAnyway: true })])
    expect(removeWorktree).toHaveBeenCalledTimes(1)
    expect(store.getState().beginUnverifiedRemovalConsent(identity)).toEqual(expect.any(String))
  })

  it('keeps a live consent bound to its call when dialog state is cleared', async () => {
    const candidate = makeCandidate({
      executionHostId: 'local',
      blockers: ['git-status-error'],
      git: {
        clean: null,
        upstreamAhead: null,
        upstreamBehind: null,
        checkedAt: null
      }
    })
    const scan = deferred<WorkspaceCleanupScanResult>()
    installWorkspaceCleanupApi(vi.fn(() => scan.promise))
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)
    const identity = getWorkspaceCleanupCandidateIdentity(candidate)
    const attemptId = store.getState().beginUnverifiedRemovalConsent(identity)!
    const removal = store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [candidate],
      unverifiedRemovalConsent: { identity, attemptId }
    })

    store.setState({ workspaceCleanupScan: null })
    expect(store.getState().beginUnverifiedRemovalConsent(identity)).toBeNull()
    scan.resolve({ scannedAt: NOW, candidates: [candidate], errors: [] })

    await expect(removal).resolves.toEqual(
      expect.objectContaining({ removedIdentities: [identity], failures: [] })
    )
  })
})
