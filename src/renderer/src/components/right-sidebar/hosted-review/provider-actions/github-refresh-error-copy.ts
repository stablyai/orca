import type { HostedReviewProvider } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import type { PRRefreshUpstreamErrorType } from '../../../../../../shared/github/pull-request-refresh-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type ChecksPanelErrorCopy = { title: string; description: string }

/** Attribute outages to GitHub; return null for actionable auth/permission/unknown errors so callers retain generic copy. */
export function getGitHubUnavailableEmptyStateCopy(
  errorType: PRRefreshUpstreamErrorType | undefined,
  t: Translate = translate
): ChecksPanelErrorCopy | null {
  if (errorType === 'server_error') {
    return {
      title: t(
        'auto.components.right.sidebar.github.refresh.error.copy.580025e7b7',
        'GitHub is unavailable'
      ),
      description: t(
        'auto.components.right.sidebar.github.refresh.error.copy.01c85b5770',
        "GitHub's API is temporarily unavailable. This panel reloads automatically once it recovers."
      )
    }
  }
  if (errorType === 'network') {
    return {
      title: t(
        'auto.components.right.sidebar.github.refresh.error.copy.d1a9f2b165',
        "Can't reach GitHub"
      ),
      description: t(
        'auto.components.right.sidebar.github.refresh.error.copy.7d01d42a3a',
        'GitHub is unreachable right now. Check your connection, then try again shortly.'
      )
    }
  }
  if (errorType === 'rate_limited') {
    return {
      title: t(
        'auto.components.right.sidebar.github.refresh.error.copy.e9d681894a',
        'GitHub rate limit reached'
      ),
      description: t(
        'auto.components.right.sidebar.github.refresh.error.copy.8c77434d6f',
        'GitHub is rate-limiting requests. This panel refreshes once the limit resets.'
      )
    }
  }
  return null
}

/** Show a banner above stale cached data: attribute outage kinds to GitHub, otherwise use generic failure copy. */
export function getChecksPanelRefreshErrorBannerLine(
  errorType: PRRefreshUpstreamErrorType | undefined,
  t: Translate = translate
): string {
  if (errorType === 'server_error') {
    return t(
      'auto.components.right.sidebar.github.refresh.error.copy.79aa06bb2c',
      "Couldn't refresh. GitHub's API is temporarily unavailable. Showing the last known status."
    )
  }
  if (errorType === 'network') {
    return t(
      'auto.components.right.sidebar.github.refresh.error.copy.6ec12cee0c',
      "Couldn't refresh. GitHub is unreachable right now. Showing the last known status."
    )
  }
  if (errorType === 'rate_limited') {
    return t(
      'auto.components.right.sidebar.github.refresh.error.copy.de088015e8',
      "Couldn't refresh. GitHub is rate-limiting requests. Showing the last known status."
    )
  }
  return t(
    'auto.components.right.sidebar.github.refresh.error.copy.d9dd7c6687',
    "Couldn't refresh from GitHub. Showing the last known status."
  )
}

export function getHostedReviewManualRefreshError(provider: HostedReviewProvider): string {
  return translate(
    'auto.components.right.sidebar.github.refresh.error.copy.manual_provider',
    "Couldn't refresh from {{provider}}. Try again.",
    {
      provider: localizedHostedReviewCopy(resolveSupportedHostedReviewCopyProvider(provider))
        .providerName
    }
  )
}
