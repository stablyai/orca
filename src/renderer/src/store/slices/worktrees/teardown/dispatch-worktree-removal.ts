import { showNestedWorktreePreservedBranchesToast } from '@/components/sidebar/nested-worktree-preserved-branches-toast'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import { callRuntimeRpc, type getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../../../runtime/runtime-worktree-selector'
import type { RemoveWorktreeOptions } from '../../worktree-removal-options'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import {
  isWorktreeRemovalReplyLost,
  settleLostWorktreeRemovalReply
} from './host-worktree-removal-state'
import { worktreeRemovalReplyTimeoutMs } from '../../../../../../shared/worktree/archive-hook-removal-gate'

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
  get: WorktreeSliceGet
  target: ReturnType<typeof getActiveRuntimeTarget>
  options: RemoveWorktreeOptions | undefined
  /** Re-checks mid-flight ownership immediately before the destructive call. */
  assertCurrent: () => void
}): Promise<RemoveWorktreeResult> {
  try {
    const result = await requestWorktreeRemoval(args)
    showNestedWorktreePreservedBranchesToast(result?.nestedPreservedBranches)
    return result
  } catch (error) {
    if (args.options?.mode === 'forget-local' || !isWorktreeRemovalReplyLost(error)) {
      throw error
    }
    // Why: the host may still be deleting; its listing answers what the lost reply would have.
    await settleLostWorktreeRemovalReply(args.get, {
      worktreeId: args.worktreeId,
      hostId: args.hostId,
      replyError: error
    })
    return {}
  }
}

async function requestWorktreeRemoval(
  args: Parameters<typeof dispatchWorktreeRemoval>[0]
): Promise<RemoveWorktreeResult> {
  const { worktreeId, hostId, force, skipArchive, target, options } = args
  const forgetLocalOnly = options?.mode === 'forget-local'
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
      ...(options?.approvedNestedWorktrees
        ? { approvedNestedWorktrees: options.approvedNestedWorktrees }
        : {}),
      allowUnverifiedPtyStop: options?.allowUnverifiedPtyStop === true,
      allowFailedArchiveHook: options?.allowFailedArchiveHook === true,
      skipArchive,
      ...snapshotPruneBatch
    })
  }
  if (options?.approvedNestedWorktrees) {
    throw new Error(
      'Nested worktree deletion is not supported by this runtime. Delete its children individually first.'
    )
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
      // Why only when set, unlike the IPC branch: this crosses a version boundary, and a host
      // that predates the gate drops unknown params silently. Send it when it means something.
      ...(options?.allowFailedArchiveHook === true ? { allowFailedArchiveHook: true } : {}),
      runHooks: !skipArchive
    },
    {
      // Why (#19334): the host may run an archive hook before it decides anything, then waits for
      // Git's delete before it replies; outlast both when a hook can run.
      timeoutMs: worktreeRemovalReplyTimeoutMs(!skipArchive)
    }
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
