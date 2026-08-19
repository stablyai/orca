import { describe, expect, it } from 'vitest'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'
import { getWorkspaceCleanupDeletionPhaseByIdentity } from './workspace-cleanup-deletion-phases'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

describe('workspace cleanup deletion phases', () => {
  it('marks only the qualified row during a same-id cleanup removal', () => {
    const local = makeCandidate({ executionHostId: 'local' })
    const remote = makeCandidate({
      worktreeId: local.worktreeId,
      executionHostId: 'ssh:ssh-1',
      connectionId: 'ssh-1'
    })
    const localIdentity = getWorkspaceCleanupCandidateIdentity(local)
    const remoteIdentity = getWorkspaceCleanupCandidateIdentity(remote)

    expect(
      getWorkspaceCleanupDeletionPhaseByIdentity(
        [local, remote],
        { [remoteIdentity]: 'deleting' },
        { [local.worktreeId]: 'deleting' }
      )
    ).toEqual({ [remoteIdentity]: 'deleting' })
    expect(localIdentity).not.toBe(remoteIdentity)
  })

  it('applies a non-cleanup deletion only to its host-qualified row', () => {
    const local = makeCandidate({ executionHostId: 'local' })
    const remote = makeCandidate({
      worktreeId: local.worktreeId,
      executionHostId: 'runtime:env-1'
    })

    expect(
      getWorkspaceCleanupDeletionPhaseByIdentity(
        [local, remote],
        {},
        { [composeWorktreeHostIdentity('local', local.worktreeId)]: 'queued' }
      )
    ).toEqual({
      [getWorkspaceCleanupCandidateIdentity(local)]: 'queued'
    })
  })
})
