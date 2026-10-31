import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { GitLabMRUpdate } from '../../../../shared/gitlab-types'
import type { Repo } from '../../../../shared/repo-types'
import { gitLabApiFor } from '@/runtime/gitlab-owner-api'

export type GitLabApprovalChange = NonNullable<GitLabMRUpdate['approval']>

function updateGitLabHostedReview(
  repo: Repo,
  mrNumber: number,
  updates: GitLabMRUpdate
): ReturnType<typeof window.api.gl.updateMR> {
  return gitLabApiFor({
    repoPath: repo.path,
    repoOwnerExecutionHostId: getRepoExecutionHostId(repo)
  }).updateMR({ repoPath: repo.path, repoId: repo.id, iid: mrNumber, updates })
}

export function markGitLabHostedReviewReadyForReview(args: {
  repo: Repo
  mrNumber: number
}): ReturnType<typeof window.api.gl.updateMR> {
  return updateGitLabHostedReview(args.repo, args.mrNumber, { readyForReview: true })
}

export function setGitLabHostedReviewApproval(args: {
  repo: Repo
  mrNumber: number
  approval: GitLabApprovalChange
}): ReturnType<typeof window.api.gl.updateMR> {
  return updateGitLabHostedReview(args.repo, args.mrNumber, { approval: args.approval })
}
