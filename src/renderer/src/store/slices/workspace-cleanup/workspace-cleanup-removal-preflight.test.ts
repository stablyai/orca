import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../types'
import type { WorkspaceCleanupScanResult } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import './create-workspace-cleanup-slice'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

describe('workspace cleanup removal and protection', () => {
  it('preflights cleanup removals in one batched scan and deletes nested workspaces globally deepest first', async () => {
    let activeDeletes = 0
    let maxActiveDeletes = 0
    const deleteOrder: string[] = []
    const candidates = [
      makeCandidate({
        worktreeId: 'repo-a::/repo/parent',
        repoId: 'repo-a',
        path: '/repo/parent',
        displayName: 'parent'
      }),
      makeCandidate({
        worktreeId: 'repo-b::/repo/parent/child',
        repoId: 'repo-b',
        path: '/repo/parent/child',
        displayName: 'child'
      }),
      makeCandidate({
        worktreeId: 'repo-c::/other',
        repoId: 'repo-c',
        path: '/other',
        displayName: 'other'
      })
    ]
    const candidateById = new Map(candidates.map((candidate) => [candidate.worktreeId, candidate]))
    const scan = vi.fn(async (args?: { worktreeIds?: string[] }) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        scannedAt: NOW,
        candidates: (args?.worktreeIds ?? []).map((id) => candidateById.get(id)!),
        errors: []
      } satisfies WorkspaceCleanupScanResult
    })
    installWorkspaceCleanupApi(scan)

    const removeWorktree = vi.fn(async (target: { id: string }) => {
      deleteOrder.push(target.id)
      activeDeletes += 1
      maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes)
      await new Promise((resolve) => setTimeout(resolve, 5))
      activeDeletes -= 1
      return { ok: true as const }
    })
    const store = createCleanupTestStore(removeWorktree)
    store.setState({
      workspaceCleanupScan: { scannedAt: NOW, candidates, errors: [] }
    } as Partial<AppState>)

    await expect(
      store
        .getState()
        .removeWorkspaceCleanupCandidates(candidates.map((candidate) => candidate.worktreeId))
    ).resolves.toEqual({
      removedIds: expect.arrayContaining(candidates.map((candidate) => candidate.worktreeId)),
      removedIdentities: expect.arrayContaining(
        candidates.map((candidate) => getWorkspaceCleanupCandidateIdentity(candidate))
      ),
      failures: []
    })

    // Why: one batched scan covers every selected row; deletes stay serial.
    expect(scan).toHaveBeenCalledTimes(1)
    expect(maxActiveDeletes).toBe(1)
    expect(deleteOrder).toEqual([
      'repo-b::/repo/parent/child',
      'repo-a::/repo/parent',
      'repo-c::/other'
    ])
    // No approvedCandidates here, so there is no confirmed row to qualify: the
    // internal-caller compatibility path leaves the host unqualified.
    expect(removeWorktree).toHaveBeenCalledWith(
      { id: 'repo-c::/other', executionHostId: null },
      false,
      {
        assertBeforeDispatch: expect.any(Function),
        suppressPreservedBranchToast: true
      }
    )
    expect(store.getState().workspaceCleanupScan?.candidates).toEqual([])
  })

  it('fails a queued removal that now needs a force the user never approved', async () => {
    const approvedCandidate = makeCandidate({ executionHostId: 'local' })
    const dirtySinceConfirmation = makeCandidate({
      executionHostId: 'local',
      tier: 'review',
      blockers: ['dirty-files'],
      git: {
        clean: false,
        upstreamAhead: 0,
        upstreamBehind: 0,
        checkedAt: NOW
      }
    })
    const scan = vi.fn().mockResolvedValue({
      scannedAt: NOW,
      candidates: [dirtySinceConfirmation],
      errors: []
    } satisfies WorkspaceCleanupScanResult)
    installWorkspaceCleanupApi(scan)
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)

    await expect(
      store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
        approvedCandidates: [approvedCandidate]
      })
    ).resolves.toEqual({
      removedIds: [],
      removedIdentities: [],
      failures: [
        {
          worktreeId: WORKTREE_ID,
          executionHostId: 'local',
          displayName: 'old-workspace',
          message: 'Workspace changed after confirmation. Refresh to review it before removing.'
        }
      ]
    })
    expect(removeWorktree).not.toHaveBeenCalled()
  })
})
