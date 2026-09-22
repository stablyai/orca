import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceCleanupScanResult } from '../../../../shared/workspace-cleanup'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  deferred,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

describe('workspace cleanup removal verification and consent', () => {
  it.each([null, NOW])(
    'fails closed when git evidence is unavailable with checkedAt=%s',
    async (checkedAt) => {
      const candidate = makeCandidate({
        executionHostId: 'local',
        blockers: ['git-status-error'],
        git: {
          clean: null,
          upstreamAhead: null,
          upstreamBehind: null,
          checkedAt
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

      const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: [candidate]
      })

      expect(result.failures).toEqual([
        expect.objectContaining({
          worktreeId: WORKTREE_ID,
          canDeleteAnyway: true,
          message: expect.stringContaining("couldn't check this workspace's git status")
        })
      ])
      expect(removeWorktree).not.toHaveBeenCalled()
    }
  )

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

  it('fails every same-repo host when an older peer omits the error host', async () => {
    const local = makeCandidate({ executionHostId: 'local' })
    const remote = makeCandidate({
      executionHostId: 'ssh:remote',
      displayName: 'remote'
    })
    installWorkspaceCleanupApi(
      vi.fn().mockResolvedValue({
        scannedAt: NOW,
        candidates: [local, remote],
        errors: [
          {
            repoId: local.repoId,
            repoName: local.repoName,
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

    expect(result.failures).toHaveLength(2)
    expect(
      result.failures.every((failure) => failure.message.includes('older connected peer'))
    ).toBe(true)
    expect(removeWorktree).not.toHaveBeenCalled()
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

  it("does not let one row's consent authorize a different identity", async () => {
    const first = makeCandidate({
      executionHostId: 'local',
      blockers: ['git-status-error'],
      git: {
        clean: null,
        upstreamAhead: null,
        upstreamBehind: null,
        checkedAt: null
      }
    })
    const second = makeCandidate({
      worktreeId: 'repo1::/tmp/second',
      path: '/tmp/second',
      displayName: 'second',
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
      vi.fn(async (args: { worktreeIds?: string[] }) => ({
        scannedAt: NOW,
        candidates: [first, second].filter((candidate) =>
          args.worktreeIds?.includes(candidate.worktreeId)
        ),
        errors: []
      }))
    )
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)
    const identity = getWorkspaceCleanupCandidateIdentity(first)
    const attemptId = store.getState().beginUnverifiedRemovalConsent(identity)!

    const result = await store.getState().removeWorkspaceCleanupCandidates([second.worktreeId], {
      approvedCandidates: [second],
      unverifiedRemovalConsent: { identity, attemptId }
    })

    expect(result.failures).toEqual([expect.objectContaining({ worktreeId: second.worktreeId })])
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('fails closed when the workspace host changes before consent is consumed', async () => {
    const approved = makeCandidate({
      executionHostId: 'local',
      blockers: ['git-status-error'],
      git: {
        clean: null,
        upstreamAhead: null,
        upstreamBehind: null,
        checkedAt: null
      }
    })
    const moved = makeCandidate({ ...approved, executionHostId: 'ssh:remote' })
    installWorkspaceCleanupApi(
      vi.fn().mockResolvedValue({ scannedAt: NOW, candidates: [moved], errors: [] })
    )
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)
    const identity = getWorkspaceCleanupCandidateIdentity(approved)
    const attemptId = store.getState().beginUnverifiedRemovalConsent(identity)!

    const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [approved],
      unverifiedRemovalConsent: { identity, attemptId }
    })

    expect(result.failures).toEqual([
      expect.objectContaining({ message: 'Workspace no longer exists.' })
    ])
    expect(removeWorktree).not.toHaveBeenCalled()
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

  it('releases consent when an earlier queue guard refuses the row', async () => {
    const candidate = makeCandidate({
      executionHostId: 'local',
      blockers: ['main-worktree', 'git-status-error'],
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
    const store = createCleanupTestStore()
    const identity = getWorkspaceCleanupCandidateIdentity(candidate)
    const attemptId = store.getState().beginUnverifiedRemovalConsent(identity)!

    const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [candidate],
      unverifiedRemovalConsent: { identity, attemptId }
    })

    expect(result.failures).toHaveLength(1)
    expect(store.getState().beginUnverifiedRemovalConsent(identity)).toEqual(expect.any(String))
  })

  it('allows different identities to hold unverified-removal grants concurrently', async () => {
    const candidates = [
      makeCandidate({
        executionHostId: 'local',
        blockers: ['git-status-error'],
        git: {
          clean: null,
          upstreamAhead: null,
          upstreamBehind: null,
          checkedAt: null
        }
      }),
      makeCandidate({
        worktreeId: 'repo1::/tmp/second',
        path: '/tmp/second',
        displayName: 'second',
        executionHostId: 'local',
        blockers: ['git-status-error'],
        git: {
          clean: null,
          upstreamAhead: null,
          upstreamBehind: null,
          checkedAt: null
        }
      })
    ]
    installWorkspaceCleanupApi(
      vi.fn(async (args: { worktreeIds?: string[] }) => ({
        scannedAt: NOW,
        candidates: candidates.filter((candidate) =>
          args.worktreeIds?.includes(candidate.worktreeId)
        ),
        errors: []
      }))
    )
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)
    const consents = candidates.map((candidate) => {
      const identity = getWorkspaceCleanupCandidateIdentity(candidate)
      return {
        identity,
        attemptId: store.getState().beginUnverifiedRemovalConsent(identity)!
      }
    })

    const results = await Promise.all(
      candidates.map((candidate, index) =>
        store.getState().removeWorkspaceCleanupCandidates([candidate.worktreeId], {
          approvedCandidates: [candidate],
          unverifiedRemovalConsent: consents[index]
        })
      )
    )

    expect(results.flatMap((result) => result.removedIdentities)).toEqual(
      expect.arrayContaining(candidates.map(getWorkspaceCleanupCandidateIdentity))
    )
    expect(removeWorktree).toHaveBeenCalledTimes(2)
  })

  it('requires recorded approval before an id-only force removal', async () => {
    const candidate = makeCandidate({
      blockers: ['unknown-base'],
      git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: NOW }
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

    const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID])

    expect(result.failures).toEqual([
      expect.objectContaining({
        message: 'Review and confirm this workspace before force deleting it.'
      })
    ])
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it.each([
    ['dismissed', makeCandidate({ executionHostId: 'local', blockers: ['dismissed'] })],
    ['recently active', makeCandidate({ executionHostId: 'local', reasons: [] })]
  ])('removes an explicitly selected %s row', async (_label, approvedCandidate) => {
    const freshCandidate = makeCandidate({
      ...approvedCandidate,
      blockers: approvedCandidate.blockers.filter((blocker) => blocker !== 'dismissed')
    })
    installWorkspaceCleanupApi(
      vi.fn().mockResolvedValue({
        scannedAt: NOW,
        candidates: [freshCandidate],
        errors: []
      })
    )
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)

    const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [approvedCandidate]
    })

    expect(result.removedIds).toEqual([WORKTREE_ID])
    expect(removeWorktree).toHaveBeenCalledTimes(1)
  })
})
