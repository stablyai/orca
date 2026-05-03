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

export type ProviderRateLimits = {
  provider: 'claude' | 'codex' | 'gemini' | 'opencode-go'
  /** 5-hour session window, null if not available. */
  session: RateLimitWindow | null
  /** 7-day weekly window, null if not available. */
  weekly: RateLimitWindow | null
  /** 30-day monthly window (OpenCode Go only), null if not available. */
  monthly?: RateLimitWindow | null
  /** Named per-model buckets (Gemini only). */
  buckets?: RateLimitBucket[]
  /** Unix ms timestamp of the last successful data update. */
  updatedAt: number
  /** Human-readable error message, null when status is 'ok'. */
  error: string | null
  status: ProviderRateLimitStatus
}

export type InactiveAccountUsage = {
  accountId: string
  claude: ProviderRateLimits | null
  updatedAt: number
  isFetching: boolean
}

export type RateLimitState = {
  claude: ProviderRateLimits | null
  codex: ProviderRateLimits | null
  gemini: ProviderRateLimits | null
  opencodeGo: ProviderRateLimits | null
  inactiveClaudeAccounts: InactiveAccountUsage[]
  inactiveCodexAccounts: InactiveAccountUsage[]
}
