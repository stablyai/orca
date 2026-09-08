import type { GitPushTarget, GitReviewHead } from '../worktree/types'

export function reviewTarget(
  remoteName: string,
  branchName: string,
  provider: GitReviewHead['provider'] = 'github'
): GitPushTarget {
  return {
    remoteName,
    branchName,
    reviewHead: {
      provider,
      host: provider === 'github' ? 'github.com' : 'gitlab.com',
      repository: 'team/repo',
      branchName
    }
  }
}
