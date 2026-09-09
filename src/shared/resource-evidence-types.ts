import type { ProviderRateLimits } from './rate-limit-types'

// Identity-free projection of RateLimitService state for machine consumers
// (`orca resource status --json`). Carries no account identity, credentials, or
// raw provider payloads — only normalized usage windows and their timestamps.

export type ResourceEvidenceWindowRole = 'BURST' | 'BUDGET' | 'UNKNOWN'

export type ResourceEvidenceWindow = {
  role: ResourceEvidenceWindowRole
  windowMinutes: number
  /** 1 - usedPercent/100. usedPercent is an integer, so this is 0.01-grained. */
  remainingRatio: number
  /** The step size of `remainingRatio`; the source is integer percent. */
  remainingRatioGranularity: 0.01
  /** ISO 8601, or null when the provider did not report a reset time. */
  resetAt: string | null
  /** Orca does not retain whether `resetAt` was provider-absolute or derived. */
  resetAtSource: 'unknown'
  /** Gemini per-model bucket name; absent for session/weekly/monthly windows. */
  pool?: string
}

export type ResourceEvidenceProvider = {
  available: boolean
  status: ProviderRateLimits['status']
  /** ISO 8601 of the last successful provider data update, or null. */
  sourceUpdatedAt: string | null
  /** `queriedAt` minus `sourceUpdatedAt` in ms; null when the source time is unknown. */
  dataAgeMs: number | null
  rateLimited: boolean
  /** ISO 8601 before which refetches should not be attempted, or null. */
  retryAt: string | null
  windows: ResourceEvidenceWindow[]
  extras?: {
    planType?: string
    resetCreditsAvailable?: number
  }
}

export type ResourceEvidence = {
  /** ISO 8601 — when this projection was produced. Not a provider observation time. */
  queriedAt: string
  providers: Partial<Record<ProviderRateLimits['provider'], ResourceEvidenceProvider>>
}
