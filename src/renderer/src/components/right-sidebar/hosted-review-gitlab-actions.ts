import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { gitLabApiFor } from '@/runtime/gitlab-owner-api'

export function markGitLabHostedReviewReadyForReview(args: {
  repo: Repo
  mrNumber: number
}): ReturnType<typeof window.api.gl.updateMR> {
  return gitLabApiFor({
    repoPath: args.repo.path,
    repoOwnerExecutionHostId: getRepoExecutionHostId(args.repo)
  }).updateMR({
    repoPath: args.repo.path,
    repoId: args.repo.id,
    iid: args.mrNumber,
    updates: { readyForReview: true }
  })
}
