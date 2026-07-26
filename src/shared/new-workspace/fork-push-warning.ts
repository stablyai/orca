import type { GitHubPrStartPoint } from '../types'

export const FORK_PUSH_NO_MAINTAINER_EDIT_WARNING =
  'This PR has "Allow edits from maintainers" off; pushing to the fork may be rejected by GitHub.'

// Why: this is the one fork target where Orca can prepare the workspace but a
// later push may still be rejected by GitHub permissions.
export function getForkPushWarning(
  result: Pick<GitHubPrStartPoint, 'pushTarget' | 'maintainerCanModify'>
): string | null {
  return result.maintainerCanModify === false &&
    result.pushTarget !== undefined &&
    result.pushTarget.remoteName !== 'origin'
    ? FORK_PUSH_NO_MAINTAINER_EDIT_WARNING
    : null
}
