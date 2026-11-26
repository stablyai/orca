import type { PreloadApi } from '../../../../../preload/api-types'
import {
  AUTO_NAME_RETRY_TIMEOUT_MS,
  AUTO_NAME_RPC_METHODS,
  type BranchAutoRenameDismissResult,
  type BranchAutoRenameRetryAvailability,
  type BranchAutoRenameRetryResult
} from '../../../../../shared/worktree/branch-auto-rename-attempt'
import { callRuntimeResult } from '../../runtime/client/web-runtime-calls'

type WorktreesApi = NonNullable<PreloadApi['worktrees']>

// The server runs these on its own store; one that predates them refuses, so no actions show.
export const webWorktreeAutoNameCalls: Pick<
  WorktreesApi,
  | 'getBranchAutoRenameRetryAvailability'
  | 'retryBranchAutoRename'
  | 'dismissBranchAutoRename'
  | 'waitBranchAutoRenameAttempt'
> = {
  getBranchAutoRenameRetryAvailability: ({ worktreeId }) =>
    callRuntimeResult<BranchAutoRenameRetryAvailability>(AUTO_NAME_RPC_METHODS.availability, {
      worktreeId
    }).catch(() => ({ available: false, runningAttemptId: null })),
  retryBranchAutoRename: ({ worktreeId }) =>
    callRuntimeResult<BranchAutoRenameRetryResult>(
      AUTO_NAME_RPC_METHODS.retry,
      { worktreeId },
      AUTO_NAME_RETRY_TIMEOUT_MS
    ),
  waitBranchAutoRenameAttempt: ({ worktreeId, attemptId }) =>
    callRuntimeResult<BranchAutoRenameRetryResult | null>(
      AUTO_NAME_RPC_METHODS.wait,
      { worktreeId, attemptId },
      AUTO_NAME_RETRY_TIMEOUT_MS
    ),
  dismissBranchAutoRename: ({ worktreeId }) =>
    callRuntimeResult<BranchAutoRenameDismissResult>(AUTO_NAME_RPC_METHODS.dismiss, {
      worktreeId
    })
}
