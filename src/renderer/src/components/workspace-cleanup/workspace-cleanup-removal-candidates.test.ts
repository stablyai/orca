import { describe, expect, it } from 'vitest'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'
import { filterWorkspaceCleanupRemovalCandidates } from './workspace-cleanup-removal-candidates'

describe('workspace cleanup removal candidates', () => {
  it('excludes workspaces already being deleted', () => {
    const deleting = makeCandidate({ worktreeId: 'repo-1::/repo/deleting' })
    const ready = makeCandidate({ worktreeId: 'repo-1::/repo/ready' })

    expect(
      filterWorkspaceCleanupRemovalCandidates([deleting, ready], {
        [deleting.worktreeId]: { isDeleting: true }
      })
    ).toEqual([ready])
  })
})
