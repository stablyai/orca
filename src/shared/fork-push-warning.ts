import type { GitHubPrStartPoint } from './types'

export const FORK_PUSH_NO_MAINTAINER_EDIT_WARNING =
  'This PR has "Allow edits from maintainers" off; pushing to the fork may be rejected by GitHub.'

// Why: only fork targets with maintainer edits explicitly disabled have the
// GitHub rejection risk; same-repo origin pushes do not.
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
