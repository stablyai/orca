import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { GiteaMutationResult } from '../../../../shared/gitea-types'
import type { GitHubPRMergeMethod } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import { giteaApiFor } from '@/runtime/gitea-owner-api'

function giteaApiForRepo(repo: Repo): ReturnType<typeof giteaApiFor> {
  return giteaApiFor({
    repoPath: repo.path,
    repoOwnerExecutionHostId: getRepoExecutionHostId(repo)
  })
}

export function mergeGiteaHostedReview(args: {
  repo: Repo
  prNumber: number
  method: GitHubPRMergeMethod
}): Promise<GiteaMutationResult> {
  return giteaApiForRepo(args.repo).mergePR({
    repoPath: args.repo.path,
    repoId: args.repo.id,
    number: args.prNumber,
    method: args.method
  })
}

export function updateGiteaHostedReviewState(args: {
  repo: Repo
  prNumber: number
  nextState: 'open' | 'closed'
}): Promise<GiteaMutationResult> {
  const api = giteaApiForRepo(args.repo)
  const request = { repoPath: args.repo.path, repoId: args.repo.id, number: args.prNumber }
  return args.nextState === 'closed' ? api.closePR(request) : api.reopenPR(request)
}

export function markGiteaReviewReady(args: {
  repo: Repo
  prNumber: number
}): Promise<GiteaMutationResult> {
  return giteaApiForRepo(args.repo).updatePR({
    repoPath: args.repo.path,
    repoId: args.repo.id,
    number: args.prNumber,
    updates: { draft: false }
  })
}
