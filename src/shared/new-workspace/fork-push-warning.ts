import type { GitHubPrStartPoint } from '../worktree/types'

export const FORK_PUSH_NO_MAINTAINER_EDIT_WARNING =
  'This PR has "Allow edits from maintainers" off; pushing to the fork may be rejected by GitHub.'

// This fork target permits workspace preparation even when GitHub may later refuse push permissions.
export function getForkPushWarning(
  result: Pick<GitHubPrStartPoint, 'pushTarget' | 'maintainerCanModify'>
): string | null {
  return result.maintainerCanModify === false &&
    result.pushTarget !== undefined &&
    result.pushTarget.remoteName !== 'origin'
    ? FORK_PUSH_NO_MAINTAINER_EDIT_WARNING
    : null
}
