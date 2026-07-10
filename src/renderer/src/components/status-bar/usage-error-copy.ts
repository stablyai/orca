import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'

export function getProviderDisplayName(provider: ProviderRateLimits['provider']): string {
  if (provider === 'claude') {
    return 'Claude'
  }
  if (provider === 'codex') {
    return 'Codex'
  }
  if (provider === 'gemini') {
    return 'Gemini'
  }
  if (provider === 'opencode-go') {
    return 'OpenCode Go'
  }
  if (provider === 'kimi') {
    return 'Kimi'
  }
  if (provider === 'minimax') {
    return 'MiniMax'
  }
  if (provider === 'grok') {
    return 'Grok'
  }
  return provider
}

function isUsageRateLimitError(message: string | null): boolean {
  return Boolean(message && /\brate[- ]?limits?\b|\brate[- ]?limited\b/i.test(message))
}

const USAGE_AUTH_ERROR_PATTERNS = [
  // Why: "OAuth" can be an upstream route label; only credential/session wording
  // should hide raw details behind the softer usage-refresh copy.
  /\binvalid (?:authentication )?credentials?\b/i,
  /\b(?:no|missing|invalid|expired|stale|unavailable) (?:oauth )?(?:access token|refresh token|token|credentials?|auth(?:entication)? session|auth cookie)\b/i,
  /\b(?:access token|refresh token|token|credentials?|auth(?:entication)? session|auth cookie) (?:is |are |was |were |could not be |cannot be |can't be )?(?:missing|unavailable|invalid|expired|stale|used|refreshed|loaded|found)\b/i,
  /\bcredentials?[ -]file (?:is |was )?(?:missing|unavailable|invalid|expired|stale)\b/i,
  /\b(?:access token|refresh token|token|credentials?|auth(?:entication)? session|auth cookie) not (?:found|available)\b/i,
  /\b(?:token data|tokens?) (?:is |are )?not available\b/i,
  /\bauth (?:is missing|tokens are missing|does not expose)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bunauthenticated\b/i,
  /\bplease reauthenticate\b/i,
  /\bsign in\b/i,
  /\blogged in to another account\b/i,
  /\bnot logged in\b/i,
  /\blog[ -]?in\b/i,
  /\blog(?:ged)? out\b/i
]

function isUsageAuthError(message: string | null): boolean {
  return Boolean(message && USAGE_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message)))
}

export function getProviderUsageStatusLabel(p: ProviderRateLimits): string {
  if (p.provider === 'claude') {
    switch (p.usageMetadata?.failureKind) {
      case 'deferred-by-live-session':
        return translate(
          'auto.components.status.bar.tooltip.0d8d7cfe15',
          'Waiting for Claude session'
        )
      case 'stale-token':
      case 'refreshable-credentials-without-token':
      case 'delegated-refresh-required':
        return translate('auto.components.status.bar.tooltip.1804cd8c3f', 'Refreshing sign-in')
      case 'network':
        return translate('auto.components.status.bar.tooltip.f8f0f9d8cc', 'Network issue')
      case 'keychain-unavailable':
        return translate('auto.components.status.bar.tooltip.bf2e739f18', 'Sign-in unavailable')
      case 'cli-unavailable':
      case 'usage-unavailable':
        return translate('auto.components.status.bar.tooltip.f8b8dbed85', 'Usage unavailable')
      case 'missing-credentials':
      case 'missing-scope':
      case 'parse':
      case 'rate-limited':
      case 'server':
      case 'unknown':
      case undefined:
        break
    }
  }
  if (isUsageRateLimitError(p.error)) {
    return translate('auto.components.status.bar.tooltip.7ad719c4bf', 'Limited')
  }
  return translate('auto.components.status.bar.tooltip.e740f92596', 'Refresh failed')
}

export function getProviderUsageErrorMessage(p: ProviderRateLimits): string {
  const fallback = translate(
    'auto.components.status.bar.tooltip.2c35eca8d4',
    'Unable to fetch usage'
  )
  if (!p.error) {
    return fallback
  }
  if (p.provider === 'claude') {
    switch (p.usageMetadata?.failureKind) {
      case 'deferred-by-live-session':
        return translate(
          'auto.components.status.bar.tooltip.3d3c9c0c1f',
          'Claude usage will refresh after the live Claude terminal rotates its credentials.'
        )
      case 'stale-token':
      case 'refreshable-credentials-without-token':
      case 'delegated-refresh-required':
        return translate(
          'auto.components.status.bar.tooltip.42fdd4da1d',
          'Claude sign-in is being refreshed. Agent sessions may still be signed in.'
        )
      case 'missing-scope':
        return p.error
      case 'network':
        return translate(
          'auto.components.status.bar.tooltip.c06c1d215d',
          'Claude usage could not be refreshed because the network request failed.'
        )
      case 'keychain-unavailable':
        return translate(
          'auto.components.status.bar.tooltip.cabdc2a9e0',
          'Claude sign-in credentials could not be read.'
        )
      case 'server':
      case 'parse':
      case 'usage-unavailable':
      case 'cli-unavailable':
        return translate(
          'auto.components.status.bar.tooltip.a7517cccb6',
          'Claude usage is unavailable right now.'
        )
      case 'missing-credentials':
      case 'rate-limited':
      case 'unknown':
      case undefined:
        break
    }
  }
  if (isUsageRateLimitError(p.error)) {
    return p.error
  }
  if (isUsageAuthError(p.error)) {
    const name = getProviderDisplayName(p.provider)
    return translate(
      'auto.components.status.bar.tooltip.8418ec448d',
      '{{value0}} usage could not be refreshed. Agent sessions may still be signed in.',
      { value0: name }
    )
  }
  return p.error
}
