import type { PRRefreshUpstreamErrorType } from '../../../../shared/github/pull-request-refresh-types'
import { translate } from '@/i18n/i18n'

export type ChecksPanelErrorCopy = { title: string; description: string }

/** Attribute outages to GitHub; return null for actionable auth/permission/unknown errors so callers retain generic copy. */
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
  return null
}

/** Show a banner above stale cached data: attribute outage kinds to GitHub, otherwise use generic failure copy. */
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
