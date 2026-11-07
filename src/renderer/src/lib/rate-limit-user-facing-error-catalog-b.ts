import type { RateLimitKnownError } from './rate-limit-user-facing-error-types'

export const KNOWN_RATE_LIMIT_ERRORS_B: RateLimitKnownError[] = [
  {
    test: 'Claude usage is rate limited right now.',
    key: 'auto.lib.rateLimits.errors.claudeRateLimited',
    fallback: 'Claude usage is rate limited right now.'
  },
  {
    test: 'Claude usage is unavailable right now.',
    key: 'auto.lib.rateLimits.errors.claudeUsageUnavailable',
    fallback: 'Claude usage is unavailable right now.'
  },
  {
    test: 'Claude OAuth access token unavailable',
    key: 'auto.lib.rateLimits.errors.claudeOauthTokenUnavailable',
    fallback: 'Claude OAuth access token unavailable'
  },
  {
    test: 'Claude Keychain credentials unavailable',
    key: 'auto.lib.rateLimits.errors.claudeKeychainUnavailable',
    fallback: 'Claude Keychain credentials unavailable'
  },
  {
    test: 'Claude plan usage is unavailable for this Claude CLI session.',
    key: 'auto.lib.rateLimits.errors.claudePlanUsageUnavailable',
    fallback: 'Claude plan usage is unavailable for this Claude CLI session.'
  },
  {
    test: 'Waiting for Claude session',
    key: 'auto.lib.rateLimits.errors.waitingForClaudeSession',
    fallback: 'Waiting for Claude session'
  },
  {
    test: /^WSL Claude config unavailable for (.+)$/i,
    key: 'auto.lib.rateLimits.errors.wslClaudeConfigUnavailable',
    fallback: 'WSL Claude config unavailable for {{distro}}',
    vars: (m) => ({ distro: m[1] ?? '' })
  },
  {
    test: 'No credentials',
    key: 'auto.lib.rateLimits.errors.noCredentials',
    fallback: 'No credentials'
  },
  {
    test: 'Rate-limit fetch aborted',
    key: 'auto.lib.rateLimits.errors.fetchAborted',
    fallback: 'Rate-limit fetch aborted'
  },
  {
    test: 'Failed to load usage data',
    key: 'auto.lib.rateLimits.errors.failedToLoadUsage',
    fallback: 'Failed to load usage data'
  },
  {
    test: 'PTY timeout — /usage panel did not render',
    key: 'auto.lib.rateLimits.errors.ptyUsageTimeout',
    fallback: 'PTY timeout — /usage panel did not render'
  },
  {
    test: 'CLI exited before /usage rendered',
    key: 'auto.lib.rateLimits.errors.cliExitedBeforeUsage',
    fallback: 'CLI exited before /usage rendered'
  },
  {
    test: 'CLI exited before status was available',
    key: 'auto.lib.rateLimits.errors.cliExitedBeforeStatus',
    fallback: 'CLI exited before status was available'
  },
  {
    test: /^Quota fetch failed \((\d+)\)$/i,
    key: 'auto.lib.rateLimits.errors.quotaFetchFailed',
    fallback: 'Quota fetch failed ({{status}})',
    vars: (m) => ({ status: m[1] ?? '' })
  },
  {
    test: /^Failed to load Gemini project ID \(HTTP (\d+)\)$/i,
    key: 'auto.lib.rateLimits.errors.geminiProjectIdLoadFailed',
    fallback: 'Failed to load Gemini project ID (HTTP {{status}})',
    vars: (m) => ({ status: m[1] ?? '' })
  },
  {
    test: 'Gemini project ID not found in API response',
    key: 'auto.lib.rateLimits.errors.geminiProjectIdMissingInResponse',
    fallback: 'Gemini project ID not found in API response'
  },
  {
    test: /^MiniMax usage fetch failed \((\d+)\)$/i,
    key: 'auto.lib.rateLimits.errors.minimaxUsageFetchFailed',
    fallback: 'MiniMax usage fetch failed ({{status}})',
    vars: (m) => ({ status: m[1] ?? '' })
  },
  {
    test: 'MiniMax returned an error',
    key: 'auto.lib.rateLimits.errors.minimaxReturnedError',
    fallback: 'MiniMax returned an error'
  },
  {
    test: 'Invalid MiniMax usage response',
    key: 'auto.lib.rateLimits.errors.minimaxInvalidUsageResponse',
    fallback: 'Invalid MiniMax usage response'
  },
  {
    test: 'Unknown MiniMax usage error',
    key: 'auto.lib.rateLimits.errors.minimaxUnknownUsageError',
    fallback: 'Unknown MiniMax usage error'
  },
  {
    test: 'Unable to read Kimi credentials',
    key: 'auto.lib.rateLimits.errors.kimiCredentialsUnreadable',
    fallback: 'Unable to read Kimi credentials'
  },
  {
    test: 'Kimi usage request failed',
    key: 'auto.lib.rateLimits.errors.kimiUsageRequestFailed',
    fallback: 'Kimi usage request failed'
  },
  {
    test: 'Grok usage request failed',
    key: 'auto.lib.rateLimits.errors.grokUsageRequestFailed',
    fallback: 'Grok usage request failed'
  },
  { test: 'RPC timeout', key: 'auto.lib.rateLimits.errors.rpcTimeout', fallback: 'RPC timeout' },
  { test: 'RPC failed', key: 'auto.lib.rateLimits.errors.rpcFailed', fallback: 'RPC failed' },
  {
    test: 'Sign in with ChatGPT',
    key: 'auto.lib.rateLimits.errors.signInWithChatgpt',
    fallback: 'Sign in with ChatGPT'
  },
  {
    test: 'Codex CLI not found',
    key: 'auto.lib.rateLimits.errors.codexCliNotFound',
    fallback: 'Codex CLI not found'
  },
  {
    test: 'Codex CLI found but could not run — Node.js may not be in your PATH',
    key: 'auto.lib.rateLimits.errors.codexCliCannotRun',
    fallback: 'Codex CLI found but could not run — Node.js may not be in your PATH'
  },
  {
    test: 'RPC process exited unexpectedly',
    key: 'auto.lib.rateLimits.errors.rpcProcessExited',
    fallback: 'RPC process exited unexpectedly'
  },
  { test: 'PTY timeout', key: 'auto.lib.rateLimits.errors.ptyTimeout', fallback: 'PTY timeout' },
  {
    test: 'Failed to parse CLI output',
    key: 'auto.lib.rateLimits.errors.failedToParseCliOutput',
    fallback: 'Failed to parse CLI output'
  },
  {
    test: 'Timed out while checking Codex sign-in status',
    key: 'auto.lib.rateLimits.errors.codexSignInCheckTimeout',
    fallback: 'Timed out while checking Codex sign-in status'
  },
  {
    test: 'Codex sign-in status is unavailable',
    key: 'auto.lib.rateLimits.errors.codexSignInStatusUnavailable',
    fallback: 'Codex sign-in status is unavailable'
  },
  {
    test: /^Codex reset failed: HTTP (\d+)$/i,
    key: 'auto.lib.rateLimits.errors.codexResetFailedHttp',
    fallback: 'Codex reset failed: HTTP {{status}}',
    vars: (m) => ({ status: m[1] ?? '' })
  },
  {
    test: /^Unknown Codex reset outcome:/i,
    key: 'auto.lib.rateLimits.errors.codexResetUnknownOutcome',
    fallback: 'Unknown Codex reset outcome'
  },
  {
    test: 'Codex reset idempotency key is required',
    key: 'auto.lib.rateLimits.errors.codexResetIdempotencyRequired',
    fallback: 'Codex reset idempotency key is required'
  },
  {
    test: 'No subscription plan — API key billing',
    key: 'auto.lib.rateLimits.errors.noSubscriptionApiKeyBilling',
    fallback: 'No subscription plan — API key billing'
  },
  {
    test: 'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.',
    key: 'auto.lib.rateLimits.errors.claudeWaitingCredentialRotate',
    fallback:
      'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.'
  },
  { test: 'Unknown error', key: 'auto.lib.rateLimits.errors.unknown', fallback: 'Unknown error' }
]
