import { useAppStore } from '@/store/index'
import type { GitStatusResult } from '../../../../../shared/git/status/git-status-types'
import { GIT_SUBMODULE_WORKING_TREE_STATUS_RUNTIME_CAPABILITY } from '../../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { RuntimeCapabilityMissingError } from '@/runtime/repository-gitlab/runtime-gitlab-api'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'

function hostServesSubmoduleWorkingTree(environmentId: string): boolean {
  const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
  return (
    !isRuntimeHostContactRevoked(entry) &&
    lastVerifiedRuntimeStatus(entry)?.capabilities?.includes(
      GIT_SUBMODULE_WORKING_TREE_STATUS_RUNTIME_CAPABILITY
    ) === true
  )
}

/**
 * A submodule's own working-tree changes, without committed-range rows or line stats.
 * Throws RuntimeCapabilityMissingError where the host would silently drop the option.
 */
export async function getRuntimeGitSubmoduleWorkingTreeStatus(
  context: RuntimeGitContext,
  submodulePath: string
): Promise<GitStatusResult> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.submoduleStatus({
      worktreePath: resolveLocalWorktreePath(context),
      submodulePath,
      connectionId: context.connectionId,
      workingTreeOnly: true
    })
  }
  if (!hostServesSubmoduleWorkingTree(target.environmentId)) {
    throw new RuntimeCapabilityMissingError()
  }
  return callRuntimeRpc<GitStatusResult>(
    target,
    'git.submoduleStatus',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      submodulePath,
      workingTreeOnly: true
    },
    { timeoutMs: 15_000 }
  )
}
