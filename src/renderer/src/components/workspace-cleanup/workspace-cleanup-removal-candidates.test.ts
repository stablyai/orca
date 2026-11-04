import { describe, expect, it } from 'vitest'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'
import { filterWorkspaceCleanupRemovalCandidates } from './workspace-cleanup-removal-candidates'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

describe('workspace cleanup removal candidates', () => {
  it('keeps a same-id sibling on another host removable', () => {
    const local = makeCandidate({ worktreeId: 'repo-1::/repo/shared', executionHostId: 'local' })
    const remote = makeCandidate({
      worktreeId: local.worktreeId,
      executionHostId: 'ssh:box',
      connectionId: 'box'
    })

    expect(
      filterWorkspaceCleanupRemovalCandidates([local, remote], {
        [composeWorktreeHostIdentity('local', local.worktreeId)]: { isDeleting: true }
      })
    ).toEqual([remote])

    expect(
      filterWorkspaceCleanupRemovalCandidates([local, remote], {
        [local.worktreeId]: { isDeleting: true, executionHostId: 'local' }
      })
    ).toEqual([remote])
  })
})
