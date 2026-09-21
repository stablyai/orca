import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import { callRuntimeRpc, type getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../../../runtime/runtime-worktree-selector'
import type { RemoveWorktreeOptions } from '../../worktree-removal-options'

/**
 * Sends the destructive removal over whichever transport owns this workspace.
 *
 * `hostId` rides every branch: local main resolves the owner from it, and the
 * runtime RPC needs it because a `repoId::path` selector alone repeats across
 * hosts (STA-4343).
 */
export async function dispatchWorktreeRemoval(args: {
  worktreeId: string
  hostId: ExecutionHostId | undefined
  force: boolean | undefined
  skipArchive: boolean
  forgetLocalOnly: boolean
  target: ReturnType<typeof getActiveRuntimeTarget>
  options: RemoveWorktreeOptions | undefined
  /** Re-checks mid-flight ownership immediately before the destructive call. */
  assertCurrent: () => void
}): Promise<RemoveWorktreeResult> {
  const { worktreeId, hostId, force, skipArchive, forgetLocalOnly, target, options } = args
  const snapshotPruneBatch = options?.snapshotPruneBatchId
    ? { snapshotPruneBatchId: options.snapshotPruneBatchId }
    : {}
  if (forgetLocalOnly) {
    return window.api.worktrees.forgetLocal({ worktreeId, hostId, ...snapshotPruneBatch })
  }
  args.assertCurrent()
  if (target.kind === 'local') {
    return window.api.worktrees.remove({
      worktreeId,
      hostId,
      force,
      allowUnverifiedPtyStop: options?.allowUnverifiedPtyStop === true,
      skipArchive,
      ...snapshotPruneBatch
    })
  }
  const effectiveHostId =
    options?.sameIdSurvivingHostId != null ? hostId : qualifyRuntimeCallHost(target, hostId)
  return callRuntimeRpc<RemoveWorktreeResult>(
    target,
    'worktree.rm',
    {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      ...(effectiveHostId ? { hostId: effectiveHostId } : {}),
      force,
      allowUnverifiedPtyStop: options?.allowUnverifiedPtyStop === true,
      runHooks: !skipArchive
    },
    { timeoutMs: 60_000 }
  )
}

function qualifyRuntimeCallHost(
  target: ReturnType<typeof getActiveRuntimeTarget>,
  hostId: ExecutionHostId | undefined
): ExecutionHostId | undefined {
  const parsedHost = parseExecutionHostId(hostId)
  if (
    target.kind === 'environment' &&
    parsedHost?.kind === 'runtime' &&
    parsedHost.environmentId === target.environmentId
  ) {
    return undefined
  }
  return hostId
}
