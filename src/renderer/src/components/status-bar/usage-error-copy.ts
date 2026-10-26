import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'
import { describeOwnerNotSetUp, getOwnerNotSetUpLabel } from './owner-not-set-up-copy'

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
  if (provider === 'antigravity') {
    return 'Antigravity'
  }
  if (provider === 'minimax') {
    return 'MiniMax'
  }
  if (provider === 'grok') {
    return 'Grok'
  }
  if (provider === 'zcode') {
    return 'ZCode'
  }
  if (provider === 'cursor') {
    return 'Cursor'
  }
  return provider
}

function isUsageRateLimitError(p: ProviderRateLimits): boolean {
  const failureKind = p.usageMetadata?.failureKind
  // Structured failure kinds outrank wording that may only name the unread rate limits.
  if (failureKind && failureKind !== 'unknown') {
    return failureKind === 'rate-limited'
  }
  const message = p.error
  // Authentication-required errors describe unread rate limits, not exhausted quota.
  if (!message || /\bauthentication required\b/i.test(message)) {
    return false
  }
  return /\brate[- ]?limits?\b|\brate[- ]?limited\b/i.test(message)
}

const USAGE_AUTH_ERROR_PATTERNS = [
  // OAuth can name an upstream route; soften details only for credential/session failures.
  /\binvalid (?:authentication )?credentials?\b/i,
  /\b(?:no|missing|invalid|expired|stale|unavailable) (?:oauth )?(?:access token|refresh token|token|credentials?|auth(?:entication)? session|auth cookie)\b/i,
  /\b(?:access token|refresh token|token|credentials?|auth(?:entication)? session|auth cookie) (?:is |are |was |were |could not be |cannot be |can't be )?(?:missing|unavailable|invalid|expired|stale|used|refreshed|loaded|found)\b/i,
  /\bcredentials?[ -]file (?:is |was )?(?:missing|unavailable|invalid|expired|stale)\b/i,
  /\b(?:access token|refresh token|token|credentials?|auth(?:entication)? session|auth cookie) not (?:found|available)\b/i,
  /\b(?:token data|tokens?) (?:is |are )?not available\b/i,
  /\bauth (?:is missing|tokens are missing|does not expose)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bunauthenticated\b/i,
  /\bauthentication required\b/i,
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

function getDelegatedCliRefreshProvider(
  p: ProviderRateLimits
): Extract<ProviderRateLimits['provider'], 'grok' | 'kimi'> | null {
  if (p.usageMetadata?.failureKind !== 'delegated-refresh-required') {
    return null
  }
  // Only these providers require a CLI-run credential rotation; Claude reports the same kind in-app.
  return p.provider === 'grok' || p.provider === 'kimi' ? p.provider : null
}

/** An idle login's access token lapsed, not the login: Claude refreshes it the next time it runs. */
export function isClaudeUsageWaitingForClaude(p: ProviderRateLimits): boolean {
  return p.provider === 'claude' && p.usageMetadata?.failureKind === 'stale-token'
}

export function getProviderUsageStatusLabel(p: ProviderRateLimits): string {
  if (p.usageMetadata?.ownerNotSetUp) {
    return getOwnerNotSetUpLabel(p.usageMetadata.ownerNotSetUp)
  }
  // Why: no refresh fixes an owner that cannot vouch for its usage, so never say "Refresh failed".
  if (p.usageMetadata?.unverifiableOwner) {
    return translate('auto.components.status.bar.tooltip.f8b8dbed85', 'Usage unavailable')
  }
  if (
    p.provider === 'antigravity' &&
    p.status === 'unavailable' &&
    p.usageMetadata?.failureKind === 'usage-unavailable'
  ) {
    return translate('auto.components.status.bar.tooltip.f8b8dbed85', 'Usage unavailable')
  }
  const delegatedCliProvider = getDelegatedCliRefreshProvider(p)
  if (delegatedCliProvider === 'grok') {
    return translate('auto.components.status.bar.tooltip.e2c6a4f917', 'Run Grok to refresh')
  }
  if (delegatedCliProvider === 'kimi') {
    return translate('auto.components.status.bar.tooltip.f90b3d7a16', 'Run Kimi to refresh')
  }
  if (p.provider === 'claude') {
    switch (p.usageMetadata?.failureKind) {
      // Why: only an older host, which still defers a refresh for a live session, reports this.
      case 'deferred-by-live-session':
        return translate(
          'auto.components.status.bar.tooltip.0d8d7cfe15',
          'Waiting for Claude session'
        )
      case 'stale-token':
        return translate(
          'auto.components.status.bar.tooltip.claude.waiting.label',
          'Updates when Claude runs'
        )
      // Why: Orca never refreshes a Claude login; only an older host that still does reports these.
      case 'refreshable-credentials-without-token':
      case 'delegated-refresh-required':
        return translate('auto.components.status.bar.tooltip.1804cd8c3f', 'Refreshing sign-in')
      case 'keychain-unavailable':
        return translate('auto.components.status.bar.tooltip.bf2e739f18', 'Sign-in unavailable')
      case 'cli-unavailable':
      case 'usage-unavailable':
        return translate('auto.components.status.bar.tooltip.f8b8dbed85', 'Usage unavailable')
      // Why: the host reports this only for a selected account whose own profile has no login.
      case 'missing-credentials':
        return translate('accounts.claude.usageSignInLabel', 'Sign in again')
      case 'missing-scope':
      case 'network':
      case 'no-subscription':
      case 'parse':
      case 'rate-limited':
      case 'server':
      case 'unknown':
      case undefined:
        break
    }
  }
  if (p.usageMetadata?.failureKind === 'network') {
    return translate('auto.components.status.bar.tooltip.f8f0f9d8cc', 'Network issue')
  }
  // MiniMax signals credential expiry in its payload, so generic refresh-failure copy is misleading.
  if (p.provider === 'minimax' && p.usageMetadata?.failureKind === 'stale-token') {
    return translate('auto.components.status.bar.tooltip.minimax.expired.label', 'Sign-in expired')
  }
  // Cursor-agent owns token rotation; signing into its CLI repairs expiry, not another Orca fetch.
  if (p.provider === 'cursor' && p.usageMetadata?.failureKind === 'stale-token') {
    return translate('auto.components.status.bar.tooltip.cursor.expired.label', 'Sign-in expired')
  }
  // No subscription is settled account state; refresh-failure copy would imply a fetch problem.
  if (p.usageMetadata?.failureKind === 'no-subscription') {
    return translate(
      'auto.components.status.bar.tooltip.usage.noSubscription.label',
      'No subscription'
    )
  }
  if (isUsageRateLimitError(p)) {
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
  // Why rebuilt here: the cached error keeps the language it was resolved in.
  if (p.usageMetadata?.ownerNotSetUp) {
    return describeOwnerNotSetUp(p.usageMetadata.ownerNotSetUp)
  }
  if (p.usageMetadata?.unverifiableOwner) {
    return p.error
  }
  const delegatedCliProvider = getDelegatedCliRefreshProvider(p)
  if (delegatedCliProvider === 'grok') {
    return translate(
      'auto.components.status.bar.tooltip.d1b7f509ac',
      'Run grok in a terminal on the computer running Orca and wait for it to start. If prompted, complete sign-in, then retry usage. You do not need to send a chat message.'
    )
  }
  if (delegatedCliProvider === 'kimi') {
    return translate(
      'auto.components.status.bar.tooltip.a37e8c15d4',
      'Run kimi in a terminal on the computer running Orca and wait for it to start, then retry usage.'
    )
  }
  if (p.provider === 'cursor' && p.usageMetadata?.failureKind === 'stale-token') {
    return translate(
      'auto.components.status.bar.tooltip.cursor.expired.message',
      'Run cursor-agent login in a terminal on the computer running Orca, then retry usage.'
    )
  }
  if (p.provider === 'claude') {
    switch (p.usageMetadata?.failureKind) {
      // Why: only an older host, which still defers a refresh for a live session, reports this.
      case 'deferred-by-live-session':
        return translate(
          'auto.components.status.bar.tooltip.3d3c9c0c1f',
          'Claude usage will refresh after the live Claude terminal rotates its credentials.'
        )
      case 'stale-token':
        return translate(
          'auto.components.status.bar.tooltip.claude.waiting.message',
          'Claude usage updates the next time Claude runs.'
        )
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
      case 'missing-credentials':
        return translate(
          'accounts.claude.usageSignInMessage',
          'The selected Claude account needs you to sign in again. Open Settings > AI Provider Accounts, or choose System default.'
        )
      case 'server':
      case 'parse':
      case 'usage-unavailable':
      case 'cli-unavailable':
        return translate(
          'auto.components.status.bar.tooltip.a7517cccb6',
          'Claude usage is unavailable right now.'
        )
      case 'no-subscription':
      case 'rate-limited':
      case 'unknown':
      case undefined:
        break
    }
  }
  if (isUsageRateLimitError(p)) {
    return p.error
  }
  if (p.provider === 'minimax' && p.usageMetadata?.failureKind === 'stale-token') {
    return p.usageMetadata.credentialSource === 'api-key'
      ? translate(
          'auto.components.status.bar.tooltip.minimax.expired.apiKey',
          'MiniMax API key expired. Replace it in Settings.'
        )
      : translate(
          'auto.components.status.bar.tooltip.minimax.expired.cookie',
          'MiniMax session cookie expired. Replace it in Settings.'
        )
  }
  // The entitlement verdict names the account state; generic auth copy would bury it.
  if (p.usageMetadata?.failureKind === 'no-subscription') {
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
