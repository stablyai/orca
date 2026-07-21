export type RateLimitWindow = {
  /** Percentage of the window consumed (0–100). */
  usedPercent: number
  /** Window duration in minutes: 300 (5h) or 10080 (7d). */
  windowMinutes: number
  /** Unix ms timestamp when the window resets, if known. */
  resetsAt: number | null
  /** Human-readable reset description, e.g. "2:30 PM" or "Thu". */
  resetDescription: string | null
}

export type ProviderRateLimitStatus = 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable'

export type RateLimitBucket = RateLimitWindow & {
  name: string
}

export type UsageRateLimitSource = 'oauth' | 'cli' | 'web' | 'live-session'

export type UsageRateLimitFailureKind =
  | 'missing-credentials'
  | 'stale-token'
  | 'refreshable-credentials-without-token'
  | 'delegated-refresh-required'
  | 'deferred-by-live-session'
  | 'keychain-unavailable'
  | 'missing-scope'
  | 'network'
  | 'server'
  | 'parse'
  | 'rate-limited'
  | 'cli-unavailable'
  | 'usage-unavailable'
  | 'unknown'

export type UsageRateLimitMetadata = {
  source?: UsageRateLimitSource
  attemptedSources?: UsageRateLimitSource[]
  failureKind?: UsageRateLimitFailureKind
  credentialSource?: string
  authProvenance?: string
  deferredByLiveClaudeSession?: boolean
  lastSuccessfulSource?: UsageRateLimitSource
  /** Unix ms timestamp before which usage refetches should not be attempted (from HTTP Retry-After). */
  retryAtMs?: number
}

export type ProviderRateLimits = {
  provider:
    | 'claude'
    | 'codex'
    | 'gemini'
    | 'opencode-go'
    | 'kimi'
    | 'minimax'
    | 'grok'
    | 'antigravity'
  /** 5-hour session window, null if not available. */
  session: RateLimitWindow | null
  /** 7-day weekly window, null if not available. */
  weekly: RateLimitWindow | null
  /** Claude Fable 7-day weekly window, null if not available. */
  fableWeekly?: RateLimitWindow | null
  /** 30-day monthly window (OpenCode Go, Grok unified billing), null if not available. */
  monthly?: RateLimitWindow | null
  /** Named per-model buckets (Gemini only). */
  buckets?: RateLimitBucket[]
  /** Available earned Codex rate-limit reset credits, if reported. */
  rateLimitResetCredits?: {
    availableCount: number
    /** Total earned reset credits, including spent or expired credits, if reported. */
    totalEarnedCount?: number
    /** Unix ms timestamp for the next available reset credit expiry, if reported. */
    nextExpiresAt?: number | null
    credits?: {
      status: string
      expiresAt: number | null
      grantedAt: number | null
    }[]
  } | null
  /** Subscription plan tier for the active account (Codex `plan_type`, e.g. "plus"). */
  planType?: string | null
  /** Unix ms timestamp of the last successful data update. */
  updatedAt: number
  /** Human-readable error message, null when status is 'ok'. */
  error: string | null
  status: ProviderRateLimitStatus
  usageMetadata?: UsageRateLimitMetadata
}

export type CodexRateLimitResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'

export type CodexRateLimitResetResult = {
  outcome: CodexRateLimitResetOutcome
  state: RateLimitState
}

export type RateLimitRuntimeTarget = {
  runtime: 'host' | 'wsl'
  wslDistro: string | null
}

export type InactiveAccountUsage = {
  accountId: string
  rateLimits: ProviderRateLimits | null
  updatedAt: number
  isFetching: boolean
}

export type GrokAccountStatus = {
  signedIn: boolean
  email: string | null
  teamId: string | null
  tokenFresh: boolean
  error: string | null
}

export type RateLimitState = {
  claude: ProviderRateLimits | null
  codex: ProviderRateLimits | null
  gemini: ProviderRateLimits | null
  opencodeGo: ProviderRateLimits | null
  kimi: ProviderRateLimits | null
  antigravity: ProviderRateLimits | null
  minimax: ProviderRateLimits | null
  grok: ProviderRateLimits | null
  /**
   * True when a MiniMax session cookie is persisted on disk. The cookie lives
   * outside GlobalSettings, so this flag is the durable signal that the
   * status bar uses to keep the MiniMax provider visible across reloads and
   * between snapshot refreshes.
   */
  minimaxCookieConfigured: boolean
  /** True when main finds a Grok CLI session file (~/.grok/auth.json or GROK_HOME). */
  grokAuthConfigured: boolean
  claudeTarget: RateLimitRuntimeTarget
  codexTarget: RateLimitRuntimeTarget
  inactiveClaudeAccounts: InactiveAccountUsage[]
  inactiveCodexAccounts: InactiveAccountUsage[]
}
