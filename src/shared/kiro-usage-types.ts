// Kiro CLI exposes a real monthly plan quota via its `/usage` slash command
// (e.g. "Credits (132.35 of 1000 covered in plan) ... 13.2% | resets on
// 2026-10-01 | KIRO PRO"). These types model that parsed quota — a genuine
// used/limit percentage with a reset date — not local per-conversation credits.

export type KiroUsageStatus = 'ok' | 'unavailable' | 'error'

export type KiroUsageQuota = {
  /** Credits used this billing period. */
  used: number
  /** Plan credit limit for the period. */
  limit: number
  /** Percentage of the plan consumed (0–100), as reported by the CLI. */
  usedPercent: number
  /** Reset date in ISO YYYY-MM-DD form, null when not reported. */
  resetsOn: string | null
  /** Plan tier label, e.g. "KIRO PRO", null when not reported. */
  plan: string | null
}

export type KiroUsageSnapshot = {
  status: KiroUsageStatus
  /** Parsed monthly quota, null when unavailable/error. */
  quota: KiroUsageQuota | null
  /** Human-readable error, null when status is 'ok'. */
  error: string | null
  /** Unix ms timestamp when this snapshot was produced. */
  updatedAt: number
}
