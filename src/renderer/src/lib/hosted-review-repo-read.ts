import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { hostedReviewRepoOwnerTarget } from '@/store/slices/hosted-review/hosted-review-cache-state'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type {
  HostedReviewForBranchArgs,
  HostedReviewInfo
} from '../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { Repo } from '../../../shared/repo-types'

export function readHostedReviewForRepo(
  repo: Repo,
  query: Omit<
    HostedReviewForBranchArgs,
    'repoPath' | 'repoId' | 'repoOwnerExecutionHostId' | 'reportReadOutcome'
  >
): Promise<HostedReviewInfo | null> {
  const args = { ...query, repoPath: repo.path, repoId: repo.id }
  const target = hostedReviewRepoOwnerTarget(repo)
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
