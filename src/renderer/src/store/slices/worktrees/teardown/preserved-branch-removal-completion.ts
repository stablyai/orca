import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import { preservedBranchCleanupKey } from '../../../../../../shared/preserved-branch-cleanup'
import { showPreservedBranchToast } from '@/components/sidebar/preserved-branch-toast'
import type { getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import type { RendererRemoveWorktreeResult } from '../../renderer-remove-worktree-result'
import { preservedBranchRuntimeTargetByCleanupKey } from './preserved-branch-cleanup-target'

/** Records a branch the removal preserved, offers to delete it, and names its host in the result. */
export function completePreservedBranchRemoval(args: {
  get: WorktreeSliceGet
  worktreeId: string
  hostId: ExecutionHostId | undefined
  runtimeEnvironmentId: string | undefined
  removalResult: RemoveWorktreeResult | undefined
  worktreeBeforeRemoval: Parameters<typeof showPreservedBranchToast>[1]
  target: ReturnType<typeof getActiveRuntimeTarget>
  suppressToast: boolean
}): { ok: true } & RendererRemoveWorktreeResult {
  const { get, worktreeId, hostId, runtimeEnvironmentId, removalResult } = args
  const preservedBranch = removalResult?.preservedBranch
  if (!preservedBranch) {
    return { ok: true as const }
  }
  const cleanup = {
    worktreeId,
    branchName: preservedBranch.branchName,
    expectedHead: preservedBranch.head,
    ...(hostId ? { hostId } : {}),
    ...(runtimeEnvironmentId ? { runtimeEnvironmentId } : {})
  }
  preservedBranchRuntimeTargetByCleanupKey.set(preservedBranchCleanupKey(cleanup), {
    cleanup,
    target: args.target
  })
  if (!args.suppressToast) {
    showPreservedBranchToast(removalResult, args.worktreeBeforeRemoval, (branch, expectedHead) => {
      void get().forceDeletePreservedBranch(worktreeId, branch, expectedHead, {
        ...(hostId ? { hostId } : {}),
        ...(runtimeEnvironmentId ? { runtimeEnvironmentId } : {})
      })
    })
  }
  return {
    ok: true as const,
    preservedBranch: {
      ...preservedBranch,
      ...(cleanup.hostId ? { hostId: cleanup.hostId } : {}),
      ...(cleanup.runtimeEnvironmentId
        ? { runtimeEnvironmentId: cleanup.runtimeEnvironmentId }
        : {})
    }
  }
}
