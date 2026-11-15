import * as z from 'zod'

export const STATS_USAGE_PROVIDERS = ['claude', 'codex', 'opencode', 'muse'] as const
export const STATS_USAGE_SCOPES = ['orca', 'all'] as const
export const STATS_USAGE_RANGES = ['7d', '30d', '90d', 'all'] as const
export const STATS_USAGE_MAX_SESSIONS = 100

/** Same scope/range choices as the Stats & Usage pane, with its defaults. */
export const StatsUsageParams = z.object({
  provider: z.enum(STATS_USAGE_PROVIDERS),
  scope: z.enum(STATS_USAGE_SCOPES).default('orca'),
  range: z.enum(STATS_USAGE_RANGES).default('30d'),
  sessions: z.number().int().min(0).max(STATS_USAGE_MAX_SESSIONS).default(10)
})
export type StatsUsageParams = z.input<typeof StatsUsageParams>
