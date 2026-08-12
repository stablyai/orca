import type { PRRefreshUpstreamErrorType } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export type ChecksPanelErrorCopy = { title: string; description: string }

/**
 * Attributed empty-state copy for a PR-refresh failure caused by GitHub itself
 * being unavailable (5xx outage / network / rate limit). Returns null for
 * non-outage errors (auth, permission, unknown) so the caller keeps its generic
 * "could not refresh" copy — those are user-actionable, not "GitHub is down".
 */
export function getGitHubUnavailableEmptyStateCopy(
  errorType: PRRefreshUpstreamErrorType | undefined
): ChecksPanelErrorCopy | null {
  if (errorType === 'server_error') {
    return {
      title: translate(
        'auto.components.right.sidebar.github.refresh.error.copy.580025e7b7',
        'GitHub is unavailable'
      ),
      description: translate(
        'auto.components.right.sidebar.github.refresh.error.copy.01c85b5770',
        "GitHub's API is temporarily unavailable. This panel reloads automatically once it recovers."
      )
    }
  }
  if (errorType === 'network') {
    return {
      title: translate(
        'auto.components.right.sidebar.github.refresh.error.copy.d1a9f2b165',
        "Can't reach GitHub"
      ),
      description: translate(
        'auto.components.right.sidebar.github.refresh.error.copy.7d01d42a3a',
        'GitHub is unreachable right now. Check your connection, then try again shortly.'
      )
    }
  }
  if (errorType === 'rate_limited') {
    return {
      title: translate(
        'auto.components.right.sidebar.github.refresh.error.copy.e9d681894a',
        'GitHub rate limit reached'
      ),
      description: translate(
        'auto.components.right.sidebar.github.refresh.error.copy.8c77434d6f',
        'GitHub is rate-limiting requests. This panel refreshes once the limit resets.'
      )
    }
  }
  // Non-outage errors (auth, permission, unknown) keep the caller's generic copy.
  return null
}

/**
 * One-line banner shown over stale cached PR data when the last refresh failed.
 * Always returns a line: GitHub-attributed for outage kinds, generic otherwise.
 */
export function getChecksPanelRefreshErrorBannerLine(
  errorType: PRRefreshUpstreamErrorType | undefined
): string {
  if (errorType === 'server_error') {
    return translate(
      'auto.components.right.sidebar.github.refresh.error.copy.79aa06bb2c',
      "Couldn't refresh. GitHub's API is temporarily unavailable. Showing the last known status."
    )
  }
  if (errorType === 'network') {
    return translate(
      'auto.components.right.sidebar.github.refresh.error.copy.6ec12cee0c',
      "Couldn't refresh. GitHub is unreachable right now. Showing the last known status."
    )
  }
  if (errorType === 'rate_limited') {
    return translate(
      'auto.components.right.sidebar.github.refresh.error.copy.de088015e8',
      "Couldn't refresh. GitHub is rate-limiting requests. Showing the last known status."
    )
  }
  return translate(
    'auto.components.right.sidebar.github.refresh.error.copy.d9dd7c6687',
    "Couldn't refresh from GitHub. Showing the last known status."
  )
}
