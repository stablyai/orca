import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { Repo } from '../../../../shared/repo-types'
import type { AppState } from '../types'
import { getGitHubPRCacheKey, getLegacyGitHubPRCacheKey } from './github-cache-key'

export function clearHostedReviewConflictingPrCache(args: {
  cache: NonNullable<AppState['prCache']>
  review: HostedReviewInfo | null
  repoPath: string
  repoId: string | undefined
  branch: string
  settings: AppState['settings']
  repo: Repo | undefined
}): NonNullable<AppState['prCache']> {
  if (!args.review || args.review.provider === 'github') {
    return args.cache
  }
  const keys = [
    getGitHubPRCacheKey(
      args.repoPath,
      args.repoId,
      args.branch,
      args.settings,
      args.repo?.connectionId,
      args.repo?.executionHostId,
      args.repo !== undefined
    ),
    getLegacyGitHubPRCacheKey(args.repoPath, args.repoId, args.branch),
    getLegacyGitHubPRCacheKey(args.repoPath, undefined, args.branch)
  ]
  if (!keys.some((key) => args.cache[key])) {
    return args.cache
  }
  const next = { ...args.cache }
  for (const key of keys) {
    delete next[key]
  }
  return next
}
