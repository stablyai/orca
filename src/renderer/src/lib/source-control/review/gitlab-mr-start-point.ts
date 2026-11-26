import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { GitLabMrStartPoint } from '../../../../../shared/worktree/types'
import type { ReviewStartPointFailure } from '../../../../../shared/worktree/hosted-review/review-start-point-failure-copy'

export type GitLabMrStartPointInput = {
  repoId: string
  mrIid: number
  /** The repo owner's transport; `null` (no routable owner) is refused. */
  target: RuntimeClientTarget | null
  sourceBranch?: string
  targetBranch?: string
  isCrossRepository?: boolean
  /** Creating from the MR is a user act that may start a stopped WSL distro. */
  wakeWslDistro?: boolean
}

/** Returns the resolver result as-is so callers choose between toasting and throwing on `error`. */
export async function requestGitLabMrStartPoint({
  repoId,
  mrIid,
  target,
  sourceBranch,
  targetBranch,
  isCrossRepository,
  wakeWslDistro
}: GitLabMrStartPointInput): Promise<GitLabMrStartPoint | ReviewStartPointFailure> {
  if (!target) {
    throw new Error('The project host is unresolved. Refresh the project and retry.')
  }
  const mrFields = {
    mrIid,
    ...(wakeWslDistro ? { wakeWslDistro } : {}),
    ...(sourceBranch ? { sourceBranch } : {}),
    ...(targetBranch ? { targetBranch } : {}),
    ...(isCrossRepository !== undefined ? { isCrossRepository } : {})
  }
  return target.kind === 'local'
    ? window.api.worktrees.resolveMrBase({ repoId, ...mrFields })
    : callRuntimeRpc<GitLabMrStartPoint | ReviewStartPointFailure>(
        target,
        'worktree.resolveMrBase',
        { repo: repoId, ...mrFields },
        { timeoutMs: 30_000 }
      )
}
