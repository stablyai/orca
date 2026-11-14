import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import type {
  WorkspaceCleanupPolicyChange,
  WorkspaceCleanupPolicyRead
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'

export function createWorkspaceCleanupPolicyWrite(
  owner: RuntimeClientTarget,
  change: WorkspaceCleanupPolicyChange,
  read: WorkspaceCleanupPolicyRead
) {
  const guard = {
    id: createNonSecureContextUuid(),
    expiresAt: read.expiresAt,
    expected: read.state
  }
  return {
    send: async () => {
      if (change.scope === 'global') {
        await callRuntimeRpc(owner, 'settings.update', {
          workspaceCleanupPolicy: change.rules,
          workspaceCleanupGuard: guard
        })
      } else if (owner.kind === 'local') {
        const result = await window.api.repos.update({
          repoId: change.repoId,
          hostId: 'local',
          updates: { workspaceCleanupPolicy: change.policy, workspaceCleanupGuard: guard }
        })
        if (!result) {
          throw new Error('workspace_cleanup_save_failed')
        }
      } else {
        await callRuntimeRpc(owner, 'repo.update', {
          repo: change.repoId,
          updates: { workspaceCleanupPolicy: change.policy, workspaceCleanupGuard: guard }
        })
      }
    },
    settle: async () => {
      const result = await callRuntimeRpc<{ outcome: 'applied' | 'cancelled' | 'unknown' }>(
        owner,
        'workspaceCleanup.settlePolicyWrite',
        { id: guard.id, expiresAt: guard.expiresAt }
      )
      const saved = await callRuntimeRpc<WorkspaceCleanupPolicyRead>(
        owner,
        'workspaceCleanup.policyState',
        { repoId: read.state.repoId }
      )
      const actual = change.scope === 'global' ? saved.state.rules : saved.state.projects[0]?.policy
      const desired = change.scope === 'global' ? change.rules : change.policy
      return {
        read: saved,
        outcome:
          JSON.stringify(actual) === JSON.stringify(desired)
            ? ('saved' as const)
            : result.outcome === 'cancelled'
              ? ('failed' as const)
              : ('conflict' as const)
      }
    }
  }
}
