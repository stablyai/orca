import { z } from 'zod'

export const UsageSnapshotParams = z.object({
  provider: z.enum(['claude', 'codex', 'opencode', 'muse']),
  scope: z.enum(['orca', 'all']),
  range: z.enum(['7d', '30d', '90d', 'all']),
  limit: z.number().int().positive().max(50).optional()
})

export type UsageSnapshotProvider = z.infer<typeof UsageSnapshotParams>['provider']
