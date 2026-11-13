import { describe, expect, it } from 'vitest'
import {
  buildWorkspaceCleanupSizeIndex,
  buildWorkspaceCleanupWorktreeIndex
} from './workspace-cleanup-host-indexes'
import { getWorkspaceCleanupHostIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { makeFacetCandidate } from '../query/workspace-cleanup-facet.test.fixture'

describe('facet building', () => {
  it('keeps same-id worktrees and sizes isolated by host', () => {
    const candidates = [
      makeFacetCandidate({ executionHostId: 'local' }),
      makeFacetCandidate({
        executionHostId: 'ssh:builder',
        connectionId: 'builder'
      })
    ]
    const sizes = buildWorkspaceCleanupSizeIndex(
      [
        {
          worktreeId: candidates[0]!.worktreeId,
          executionHostId: 'local',
          status: 'ok',
          sizeBytes: 10
        },
        {
          worktreeId: candidates[1]!.worktreeId,
          executionHostId: 'ssh:builder',
          status: 'ok',
          sizeBytes: 20
        }
      ],
      candidates
    )

    expect(sizes.get(getWorkspaceCleanupHostIdentity('local', candidates[0]!.worktreeId))).toBe(10)
    expect(
      sizes.get(getWorkspaceCleanupHostIdentity('ssh:builder', candidates[1]!.worktreeId))
    ).toBe(20)
    expect(sizes.has(candidates[0]!.worktreeId)).toBe(false)
  })

  it('does not apply a legacy size to duplicate candidate ids', () => {
    const candidates = [
      makeFacetCandidate({ executionHostId: 'local' }),
      makeFacetCandidate({
        executionHostId: 'ssh:builder',
        connectionId: 'builder'
      })
    ]
    const sizes = buildWorkspaceCleanupSizeIndex(
      [{ worktreeId: candidates[0]!.worktreeId, status: 'ok', sizeBytes: 10 }],
      candidates
    )

    expect(sizes.size).toBe(0)
  })

  it('does not apply duplicate legacy size rows to one current candidate', () => {
    const candidate = makeFacetCandidate({ executionHostId: 'local' })
    const sizes = buildWorkspaceCleanupSizeIndex(
      [
        { worktreeId: candidate.worktreeId, status: 'ok', sizeBytes: 10 },
        { worktreeId: candidate.worktreeId, status: 'ok', sizeBytes: 20 }
      ],
      [candidate]
    )

    expect(sizes.size).toBe(0)
  })

  it('does not assign legacy worktree metadata with multi-host repo ownership', () => {
    const index = buildWorkspaceCleanupWorktreeIndex(
      { 'repo-1': [{ id: 'w1', repoId: 'repo-1' }] },
      [
        { id: 'repo-1', executionHostId: 'local' },
        { id: 'repo-1', executionHostId: 'ssh:builder' }
      ]
    )

    expect(index.size).toBe(0)
  })
})
