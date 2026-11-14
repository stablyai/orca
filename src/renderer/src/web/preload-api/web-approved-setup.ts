import { WORKTREE_RUN_APPROVED_SETUP_RUNTIME_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'
import type {
  RunApprovedWorktreeSetupArgs,
  RunApprovedWorktreeSetupResult
} from '../../../../shared/worktree/create-types'
import { toRuntimeWorktreeSelector } from '../../runtime/rpc/targets/runtime-worktree-selector'
import { callRuntimeResult, getRemoteRuntimeStatus } from './web-runtime-calls'

/** Paired web clients run approved setup on their host; older hosts lack the method. */
export async function runApprovedSetupOnWebHost(
  args: RunApprovedWorktreeSetupArgs
): Promise<RunApprovedWorktreeSetupResult> {
  const status = await getRemoteRuntimeStatus()
  if (!status.capabilities?.includes(WORKTREE_RUN_APPROVED_SETUP_RUNTIME_CAPABILITY)) {
    return { status: 'unsupported' }
  }
  return callRuntimeResult<RunApprovedWorktreeSetupResult>('worktree.runApprovedSetup', {
    worktree: toRuntimeWorktreeSelector(args.worktreeId),
    approvedSetupHash: args.approvedSetupHash
  })
}
