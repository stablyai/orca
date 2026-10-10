import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { settingsForHostedReviewRepoOwner } from '@/store/slices/hosted-review-cache-state'
import type { AppState } from '@/store/types'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { HostedReviewForBranchArgs, HostedReviewInfo } from '../../../shared/hosted-review'
import type { Repo } from '../../../shared/repo-types'

export function readHostedReviewForRepo(
  repo: Repo,
  settings: AppState['settings'],
  query: Omit<HostedReviewForBranchArgs, 'repoPath' | 'repoId' | 'repoOwnerExecutionHostId'>
): Promise<HostedReviewInfo | null> {
  const args = { ...query, repoPath: repo.path, repoId: repo.id }
  const target = getActiveRuntimeTarget(settingsForHostedReviewRepoOwner(settings, repo))
  return target.kind === 'environment'
    ? callRuntimeRpc<HostedReviewInfo | null>(
        target,
        'hostedReview.forBranch',
        { repo: repo.id, ...args },
        { timeoutMs: 30_000 }
      )
    : window.api.hostedReview.forBranch({
        ...args,
        repoOwnerExecutionHostId: getRepoExecutionHostId(repo)
      })
}
