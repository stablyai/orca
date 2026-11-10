import type { PreloadApi } from '../../../../preload/api-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { worktreeRemovalReplyTimeoutMs } from '../../../../shared/worktree/archive-hook-removal-gate'
import { toRuntimeWorktreeSelector } from '../../runtime/rpc/targets/runtime-worktree-selector'
import { callRuntimeResult } from './web-runtime-calls'
import { invalidateRuntimeWorktreeCaches } from './web-runtime-session'

type WebWorktreesApi = NonNullable<Partial<PreloadApi>['worktrees']>

export function createWebWorktreeRemovalCalls(): Pick<
  WebWorktreesApi,
  'previewNestedRemoval' | 'remove'
> {
  return {
    previewNestedRemoval: ({ worktreeId, hostId }) =>
      callRuntimeResult<GitWorktreeInfo[]>('worktree.previewNestedRemoval', {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        ...(hostId ? { hostId } : {})
      }),
    remove: async ({
      worktreeId,
      hostId,
      force,
      approvedNestedWorktrees,
      allowUnverifiedPtyStop,
      skipArchive
    }) => {
      invalidateRuntimeWorktreeCaches()
      return callRuntimeResult<RemoveWorktreeResult>(
        'worktree.rm',
        {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          ...(hostId ? { hostId } : {}),
          force,
          ...(approvedNestedWorktrees ? { approvedNestedWorktrees } : {}),
          // Forward Force Delete waiver or paired clients stay wedged (#11960).
          allowUnverifiedPtyStop,
          runHooks: skipArchive !== true
        },
        // Why: the host replies once Git has deleted the checkout, past the default 30 s budget.
        worktreeRemovalReplyTimeoutMs(skipArchive !== true, approvedNestedWorktrees?.length)
      )
    }
  }
}
