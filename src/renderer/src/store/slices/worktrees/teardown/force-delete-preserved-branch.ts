import type { WorktreeSlice } from '../../worktree-helpers'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../../../runtime/runtime-worktree-selector'
import { preservedBranchCleanupKey } from '../../../../../../shared/preserved-branch-cleanup'
import type { ForceDeleteWorktreeBranchResult } from '../../../../../../shared/worktree/create-types'
import type { PreservedBranchCleanup } from '../../../../../../shared/preserved-branch-cleanup'
import { preservedBranchRuntimeTargetByCleanupKey } from './preserved-branch-cleanup-target'
import { settingsForWorktreeOwner } from '../listing/worktree-owner-settings'
import { getPreservedBranchDeletionErrorCopy } from '@/components/sidebar/worktree-removal-error-copy'

export function createForceDeletePreservedBranch(
  _set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['forceDeletePreservedBranch'] {
  return async (worktreeId, branchName, expectedHead, options) => {
    try {
      const requestedCleanup: PreservedBranchCleanup = {
        worktreeId,
        branchName,
        expectedHead,
        ...(options?.hostId ? { hostId: options.hostId } : {}),
        ...(options?.runtimeEnvironmentId
          ? { runtimeEnvironmentId: options.runtimeEnvironmentId }
          : {})
      }
      const requestedCleanupKey = preservedBranchCleanupKey(requestedCleanup)
      const exactRetainedTarget = preservedBranchRuntimeTargetByCleanupKey.get(requestedCleanupKey)
      const matchingRetainedTargets = exactRetainedTarget
        ? [exactRetainedTarget]
        : [...preservedBranchRuntimeTargetByCleanupKey.values()].filter(
            ({ cleanup }) =>
              cleanup.worktreeId === worktreeId &&
              cleanup.branchName === branchName &&
              cleanup.expectedHead === expectedHead
          )
      const retainedTarget =
        exactRetainedTarget ??
        (options?.hostId || options?.runtimeEnvironmentId || matchingRetainedTargets.length !== 1
          ? undefined
          : matchingRetainedTargets[0])
      if ((options?.hostId || options?.runtimeEnvironmentId) && !retainedTarget) {
        throw new Error(`No preserved branch cleanup is pending for "${branchName}".`)
      }
      // Ambiguous route: deleting against the active runtime could hit the wrong host's branch.
      // Localized because it surfaces in the toast below; the throw above mirrors a main-process
      // message verbatim (orca-runtime.ts, ipc/worktrees.ts) and must stay in sync with it.
      if (!retainedTarget && matchingRetainedTargets.length > 1) {
        throw new Error(
          translate(
            'auto.store.slices.worktrees.preservedBranchCleanupHostAmbiguous',
            'Multiple preserved branch cleanups are pending for "{{value0}}"; specify the host.',
            { value0: branchName }
          )
        )
      }
      const cleanupHostId = options?.hostId ?? retainedTarget?.cleanup.hostId
      // Why: the removed row no longer records its nested HUB owner, so retain the deletion-time route.
      const target =
        retainedTarget?.target ??
        getActiveRuntimeTarget(settingsForWorktreeOwner(get(), worktreeId))
      const parsedCleanupHost = parseExecutionHostId(cleanupHostId)
      const effectiveHostId =
        target.kind === 'environment' &&
        parsedCleanupHost?.kind === 'runtime' &&
        parsedCleanupHost.environmentId === target.environmentId
          ? undefined
          : cleanupHostId
      const result = await (target.kind === 'local'
        ? window.api.worktrees.forceDeletePreservedBranch({
            worktreeId,
            branchName,
            expectedHead,
            ...(effectiveHostId ? { hostId: effectiveHostId } : {})
          })
        : callRuntimeRpc<ForceDeleteWorktreeBranchResult>(
            target,
            'worktree.forceDeleteBranch',
            {
              worktree: toRuntimeWorktreeSelector(worktreeId),
              branchName,
              expectedHead,
              ...(effectiveHostId ? { hostId: effectiveHostId } : {})
            },
            { timeoutMs: 15_000 }
          ))
      if (options?.suppressToast !== true) {
        toast.success(translate('auto.store.slices.worktrees.19db0085fb', 'Local branch deleted'), {
          description: translate(
            'auto.store.slices.worktrees.5a58e03a26',
            'Deleted "{{value0}}".',
            { value0: branchName }
          )
        })
      }
      preservedBranchRuntimeTargetByCleanupKey.delete(
        retainedTarget ? preservedBranchCleanupKey(retainedTarget.cleanup) : requestedCleanupKey
      )
      return { ok: true as const, ...result }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (options?.suppressToast !== true) {
        toast.error(
          translate('auto.store.slices.worktrees.0216895fb5', 'Failed to delete branch'),
          {
            description: getPreservedBranchDeletionErrorCopy(error)
          }
        )
      }
      return { ok: false as const, error }
    }
  }
}
