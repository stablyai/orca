import type { GitHubPrStartPoint } from '../../../shared/types'

export const FORK_PUSH_NO_MAINTAINER_EDIT_WARNING =
  'This PR has "Allow edits from maintainers" off; pushing to the fork may be rejected by GitHub.'

// Why: only warn for fork PRs where the push target points away from origin and
// whose author left "Allow edits from maintainers" off. That's the one case
// where our push to the contributor's fork can be rejected by GitHub. Returns
// the warning text to show, or null when no warning applies.
export function getForkPushWarning(
  result: Pick<GitHubPrStartPoint, 'pushTarget' | 'maintainerCanModify'>
): string | null {
  if (
    result.maintainerCanModify === false &&
    result.pushTarget !== undefined &&
    result.pushTarget.remoteName !== 'origin'
  ) {
    return FORK_PUSH_NO_MAINTAINER_EDIT_WARNING
  }
  return null
}
