import type { RateLimitKnownError } from './rate-limit-user-facing-error-types'

export const KNOWN_RATE_LIMIT_ERRORS_A: RateLimitKnownError[] = [
  {
    test: 'Session cookie not configured',
    key: 'auto.lib.rateLimits.errors.sessionCookieNotConfigured',
    fallback: 'Session cookie not configured'
  },
  {
    test: 'No auth cookie found — paste the full Cookie header from opencode.ai DevTools',
    key: 'auto.lib.rateLimits.errors.opencodeNoAuthCookie',
    fallback: 'No auth cookie found — paste the full Cookie header from opencode.ai DevTools'
  },
  {
    test: 'No workspace ID found — set a Workspace ID override in settings',
    key: 'auto.lib.rateLimits.errors.opencodeNoWorkspaceId',
    fallback: 'No workspace ID found — set a Workspace ID override in settings'
  },
  {
    test: /^No workspace ID found\b/i,
    key: 'auto.lib.rateLimits.errors.opencodeNoWorkspaceIdShort',
    fallback: 'No workspace ID found'
  },
  {
    test: /^Invalid workspace ID format:/i,
    key: 'auto.lib.rateLimits.errors.opencodeInvalidWorkspaceId',
    fallback: 'Invalid workspace ID format'
  },
  {
    test: /^Workspaces fetch failed \((\d+)\)$/i,
    key: 'auto.lib.rateLimits.errors.workspacesFetchFailed',
    fallback: 'Workspaces fetch failed ({{status}})',
    vars: (m) => ({ status: m[1] ?? '' })
  },
  {
    test: /^Usage page fetch failed \((\d+)\)$/i,
    key: 'auto.lib.rateLimits.errors.usagePageFetchFailed',
    fallback: 'Usage page fetch failed ({{status}})',
    vars: (m) => ({ status: m[1] ?? '' })
  },
  {
    test: 'Could not parse usage data from page',
    key: 'auto.lib.rateLimits.errors.couldNotParseUsagePage',
    fallback: 'Could not parse usage data from page'
  },
  {
    test: 'Could not parse usage data from any available workspace',
    key: 'auto.lib.rateLimits.errors.couldNotParseUsageAnyWorkspace',
    fallback: 'Could not parse usage data from any available workspace'
  },
  {
    test: 'MiniMax session cookie not configured',
    key: 'auto.lib.rateLimits.errors.minimaxCookieNotConfigured',
    fallback: 'MiniMax session cookie not configured'
  },
  {
    test: 'MiniMax session expired. Replace the MiniMax cookie in Settings.',
    key: 'auto.lib.rateLimits.errors.minimaxSessionExpired',
    fallback: 'MiniMax session expired. Replace the MiniMax cookie in Settings.'
  },
  {
    test: 'MiniMax auth cookie not found — paste a Cookie header with _token',
    key: 'auto.lib.rateLimits.errors.minimaxAuthCookieMissing',
    fallback: 'MiniMax auth cookie not found — paste a Cookie header with _token'
  },
  {
    test: 'MiniMax usage data for the configured model was not found',
    key: 'auto.lib.rateLimits.errors.minimaxModelUsageMissing',
    fallback: 'MiniMax usage data for the configured model was not found'
  },
  {
    test: 'MiniMax session cookie could not be decrypted',
    key: 'auto.lib.rateLimits.errors.minimaxCookieDecryptFailed',
    fallback: 'MiniMax session cookie could not be decrypted'
  },
  {
    test: 'Not signed in to Kimi Code',
    key: 'auto.lib.rateLimits.errors.kimiNotSignedIn',
    fallback: 'Not signed in to Kimi Code'
  },
  {
    test: 'Kimi credentials file is invalid',
    key: 'auto.lib.rateLimits.errors.kimiCredentialsInvalid',
    fallback: 'Kimi credentials file is invalid'
  },
  {
    test: 'Kimi credentials file is missing an access token',
    key: 'auto.lib.rateLimits.errors.kimiCredentialsMissingToken',
    fallback: 'Kimi credentials file is missing an access token'
  },
  {
    test: 'Kimi usage response did not include quota windows',
    key: 'auto.lib.rateLimits.errors.kimiQuotaWindowsMissing',
    fallback: 'Kimi usage response did not include quota windows'
  },
  {
    test: /^WSL Kimi home unavailable for (.+)$/i,
    key: 'auto.lib.rateLimits.errors.wslKimiHomeUnavailable',
    fallback: 'WSL Kimi home unavailable for {{distro}}',
    vars: (m) => ({ distro: m[1] ?? '' })
  },
  {
    test: /^Kimi session expired — run kimi (.+), then retry usage\.$/i,
    key: 'auto.lib.rateLimits.errors.kimiSessionExpired',
    fallback: 'Kimi session expired — run kimi {{where}}, then retry usage.',
    vars: (m) => ({ where: m[1] ?? '' })
  },
  {
    test: /^Kimi usage request unauthorized \(HTTP (\d+)\)$/i,
    key: 'auto.lib.rateLimits.errors.kimiUsageUnauthorizedHttp',
    fallback: 'Kimi usage request unauthorized (HTTP {{status}})',
    vars: (m) => ({ status: m[1] ?? '' })
  },
  {
    test: /^Kimi usage request failed \(HTTP (\d+)\)$/i,
    key: 'auto.lib.rateLimits.errors.kimiUsageFailedHttp',
    fallback: 'Kimi usage request failed (HTTP {{status}})',
    vars: (m) => ({ status: m[1] ?? '' })
  },
  {
    test: 'Not signed in to Grok — run grok login',
    key: 'auto.lib.rateLimits.errors.grokNotSignedIn',
    fallback: 'Not signed in to Grok — run grok login'
  },
  {
    test: 'Grok auth file is invalid',
    key: 'auto.lib.rateLimits.errors.grokAuthInvalid',
    fallback: 'Grok auth file is invalid'
  },
  {
    test: 'Unable to read Grok auth file',
    key: 'auto.lib.rateLimits.errors.grokAuthUnreadable',
    fallback: 'Unable to read Grok auth file'
  },
  {
    test: 'Grok sign-in expired — run grok on the computer running Orca; sign in if prompted. No chat message is needed.',
    key: 'auto.lib.rateLimits.errors.grokSignInExpired',
    fallback:
      'Grok sign-in expired — run grok on the computer running Orca; sign in if prompted. No chat message is needed.'
  },
  {
    test: 'Grok billing response did not include config',
    key: 'auto.lib.rateLimits.errors.grokBillingConfigMissing',
    fallback: 'Grok billing response did not include config'
  },
  {
    test: 'Grok billing response did not include credit usage',
    key: 'auto.lib.rateLimits.errors.grokBillingUsageMissing',
    fallback: 'Grok billing response did not include credit usage'
  },
  {
    test: /^Grok usage request unauthorized \(HTTP (\d+)\)$/i,
    key: 'auto.lib.rateLimits.errors.grokUsageUnauthorizedHttp',
    fallback: 'Grok usage request unauthorized (HTTP {{status}})',
    vars: (m) => ({ status: m[1] ?? '' })
  },
  {
    test: /^Grok usage request failed \(HTTP (\d+)\)$/i,
    key: 'auto.lib.rateLimits.errors.grokUsageFailedHttp',
    fallback: 'Grok usage request failed (HTTP {{status}})',
    vars: (m) => ({ status: m[1] ?? '' })
  },
  {
    test: 'Gemini CLI OAuth is disabled in settings',
    key: 'auto.lib.rateLimits.errors.geminiOauthDisabled',
    fallback: 'Gemini CLI OAuth is disabled in settings'
  },
  {
    test: 'Gemini CLI credentials not found',
    key: 'auto.lib.rateLimits.errors.geminiCredentialsNotFound',
    fallback: 'Gemini CLI credentials not found'
  },
  {
    test: 'Gemini project ID not found',
    key: 'auto.lib.rateLimits.errors.geminiProjectIdNotFound',
    fallback: 'Gemini project ID not found'
  },
  {
    test: 'Token refresh failed',
    key: 'auto.lib.rateLimits.errors.tokenRefreshFailed',
    fallback: 'Token refresh failed'
  },
  {
    test: 'Codex not signed in',
    key: 'auto.lib.rateLimits.errors.codexNotSignedIn',
    fallback: 'Codex not signed in'
  },
  {
    test: 'Codex home unavailable',
    key: 'auto.lib.rateLimits.errors.codexHomeUnavailable',
    fallback: 'Codex home unavailable'
  },
  {
    test: /^WSL Codex home unavailable for (.+)$/i,
    key: 'auto.lib.rateLimits.errors.wslCodexHomeUnavailable',
    fallback: 'WSL Codex home unavailable for {{distro}}',
    vars: (m) => ({ distro: m[1] ?? '' })
  },
  {
    test: 'Codex is rebuilding its session index; usage will refresh when recovery finishes',
    key: 'auto.lib.rateLimits.errors.codexRebuildingIndex',
    fallback: 'Codex is rebuilding its session index; usage will refresh when recovery finishes'
  },
  {
    test: /\bchatgpt authentication required to read rate limits\b/i,
    key: 'auto.lib.rateLimits.errors.chatgptAuthRequired',
    fallback: 'ChatGPT authentication required to read rate limits'
  }
]
