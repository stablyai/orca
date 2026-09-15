import { beforeEach, describe, expect, it } from 'vitest'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { clearWorkspaceActivationRecoveryLifecycle } from './workspace-activation-recovery-lifecycle'
import {
  markLatestActivationRecoveryAttempt,
  readLatestActivationRecoveryAttempt
} from './workspace-activation-recovery-attempts'
import {
  readActivationRecoveryFailureSurfaceIds,
  recordActivationRecoveryFailureSurfaceIds
} from './workspace-activation-recovery-failure-snapshots'
import {
  publishWorkspaceActivationRecoveryPresentation,
  readWorkspaceActivationRecoveryPresentation
} from './workspace-activation-recovery-presentation'
import {
  readWorkspaceSurfaceProducerEntries,
  registerWorkspaceSurfaceProducer
} from './workspace-surface-production'

const SSH_HOST = toSshExecutionHostId('box')

function registerLifecycle(
  workspaceKey: string,
  executionHostId: 'local' | typeof SSH_HOST,
  attemptId: string
): void {
  const producer = registerWorkspaceSurfaceProducer({
    workspaceKey,
    executionHostId,
    attemptId
  })
  producer.failed('failed')
  recordActivationRecoveryFailureSurfaceIds(attemptId, new Set([`${attemptId}-surface`]))
  markLatestActivationRecoveryAttempt({ workspaceKey, executionHostId, attemptId })
  publishWorkspaceActivationRecoveryPresentation({
    workspaceKey,
    executionHostId,
    attemptId,
    kind: 'producer-failed',
    retry: () => undefined
  })
}

beforeEach(() => {
  clearWorkspaceActivationRecoveryLifecycle({})
})

describe('workspace activation recovery lifecycle', () => {
  it('clears all recovery ownership when a workspace is deleted', () => {
    registerLifecycle('worktree-1', 'local', 'local-1')
    registerLifecycle('worktree-1', SSH_HOST, 'ssh-1')
    registerLifecycle('worktree-2', 'local', 'local-2')

    clearWorkspaceActivationRecoveryLifecycle({ workspaceKey: 'worktree-1' })

    expect(
      readWorkspaceSurfaceProducerEntries({ workspaceKey: 'worktree-1', executionHostId: 'local' })
    ).toEqual([])
    expect(
      readWorkspaceSurfaceProducerEntries({ workspaceKey: 'worktree-1', executionHostId: SSH_HOST })
    ).toEqual([])
    expect(readWorkspaceActivationRecoveryPresentation('worktree-1', 'local')).toBeNull()
    expect(
      readLatestActivationRecoveryAttempt({
        workspaceKey: 'worktree-1',
        executionHostId: 'local',
        attemptId: 'unused'
      })
    ).toBeUndefined()
    expect(readActivationRecoveryFailureSurfaceIds('local-1')).toBeUndefined()
    expect(readActivationRecoveryFailureSurfaceIds('ssh-1')).toBeUndefined()
    expect(
      readWorkspaceSurfaceProducerEntries({ workspaceKey: 'worktree-2', executionHostId: 'local' })
    ).toHaveLength(1)
  })

  it('clears only the retired execution host across workspaces', () => {
    registerLifecycle('worktree-1', SSH_HOST, 'ssh-1')
    registerLifecycle('worktree-2', SSH_HOST, 'ssh-2')
    registerLifecycle('worktree-1', 'local', 'local-1')

    clearWorkspaceActivationRecoveryLifecycle({ executionHostId: SSH_HOST })

    expect(
      readWorkspaceSurfaceProducerEntries({ workspaceKey: 'worktree-1', executionHostId: SSH_HOST })
    ).toEqual([])
    expect(
      readWorkspaceSurfaceProducerEntries({ workspaceKey: 'worktree-2', executionHostId: SSH_HOST })
    ).toEqual([])
    expect(readWorkspaceActivationRecoveryPresentation('worktree-2', SSH_HOST)).toBeNull()
    expect(readActivationRecoveryFailureSurfaceIds('ssh-1')).toBeUndefined()
    expect(readActivationRecoveryFailureSurfaceIds('ssh-2')).toBeUndefined()
    expect(
      readWorkspaceSurfaceProducerEntries({ workspaceKey: 'worktree-1', executionHostId: 'local' })
    ).toHaveLength(1)
    expect(readWorkspaceActivationRecoveryPresentation('worktree-1', 'local')).not.toBeNull()
  })
})
