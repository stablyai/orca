import type { ProviderRateLimits } from './rate-limit-types'

// Identity-free projection of RateLimitService state for machine consumers
// (`orca resource status --json`). Carries no account identity, credentials, or
// raw provider payloads — only normalized usage windows and their timestamps.

/**
 * Generic capacity role for routing relevance, derived from the window's
 * duration: short rolling windows are `BURST`, long-horizon caps are `BUDGET`,
 * and an unrecognised duration is `UNKNOWN`. It is deliberately not a stable
 * identity — several distinct quotas can share a role.
 */
export type ResourceEvidenceWindowRole = 'BURST' | 'BUDGET' | 'UNKNOWN'

/**
 * Stable discriminator for the underlying normalized quota window, mirroring the
 * `ProviderRateLimits` field the window was projected from. Unlike array
 * position (which is not identity) and `role` (which is not unique), a consumer
 * can rely on `scope` to tell e.g. `weekly` from `fableWeekly` even though both
 * are `BUDGET` / 10080-minute windows.
 */
export type ResourceEvidenceWindowScope =
  | 'session'
  | 'weekly'
  | 'fableWeekly'
  | 'monthly'
  | 'bucket'

export type ResourceEvidenceWindow = {
  role: ResourceEvidenceWindowRole
  scope: ResourceEvidenceWindowScope
  windowMinutes: number
  /** 1 - usedPercent/100. usedPercent is an integer, so this is 0.01-grained. */
  remainingRatio: number
  /** The step size of `remainingRatio`; the source is integer percent. */
  remainingRatioGranularity: 0.01
  /** ISO 8601, or null when the provider did not report a reset time. */
  resetAt: string | null
  /** Orca does not retain whether `resetAt` was provider-absolute or derived. */
  resetAtSource: 'unknown'
  /** Model/bucket name for `scope: 'bucket'` windows (Gemini); absent otherwise. */
  pool?: string
}

export type ResourceEvidenceProvider = {
  /**
   * True when the last fetch succeeded (`status === 'ok'`) AND at least one
   * usage window is present — i.e. a quota number can actually be read. A
   * provider whose fetch succeeded but reported no windows is `available: false`
   * with `status: 'ok'`; a consumer that only cares whether the fetch worked
   * should read `status` directly.
   */
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
