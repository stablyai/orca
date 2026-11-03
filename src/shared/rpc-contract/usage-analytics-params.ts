import { z } from 'zod'

export const UsageAnalyticsProviderParams = z.object({
  provider: z.enum(['claude', 'codex', 'opencode', 'muse'])
})
export const SetUsageAnalyticsEnabledParams = UsageAnalyticsProviderParams.extend({
  enabled: z.boolean()
})
export const RefreshUsageAnalyticsParams = UsageAnalyticsProviderParams.extend({
  force: z.boolean().optional()
})
export const GetUsageAnalyticsSnapshotParams = UsageAnalyticsProviderParams.extend({
  scope: z.enum(['orca', 'all']),
  range: z.enum(['7d', '30d', '90d', 'all']),
  // Why capped: the snapshot crosses the remote reply budget, and the pane only shows 10 rows.
  limit: z.number().int().min(1).max(50).optional()
})
