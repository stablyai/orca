import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import type { WorktreeOperationRoute } from '@/lib/workspace/ownership/worktree-operation-route'
import { preservedBranchCleanupKey } from '../../../../../../shared/git/branches/preserved-branch-cleanup'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { PreservedBranchCleanup } from '../../../../../../shared/git/branches/preserved-branch-cleanup'

export const preservedBranchRuntimeTargetByCleanupKey = new Map<
  string,
  { cleanup: PreservedBranchCleanup; target: RuntimeClientTarget }
>()

export function rememberPreservedBranchCleanup(
  worktreeId: string,
  preservedBranch: RemoveWorktreeResult['preservedBranch'],
  hostId: ExecutionHostId | undefined,
  removalRoute: WorktreeOperationRoute | null,
  target: RuntimeClientTarget
): PreservedBranchCleanup | null {
  const cleanup = preservedBranch
    ? {
        worktreeId,
        branchName: preservedBranch.branchName,
        expectedHead: preservedBranch.head,
        ...(hostId ? { hostId } : {}),
        ...(removalRoute?.runtimeEnvironmentId
          ? { runtimeEnvironmentId: removalRoute.runtimeEnvironmentId }
          : {})
      }
    : null
  if (preservedBranch) {
    preservedBranchRuntimeTargetByCleanupKey.set(preservedBranchCleanupKey(cleanup!), {
      cleanup: cleanup!,
      target
    })
  }
  return cleanup
}
