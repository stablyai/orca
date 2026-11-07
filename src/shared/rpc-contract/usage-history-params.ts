import { z } from 'zod'

const UsageProvider = z.enum(['claude', 'codex', 'opencode', 'muse'])

export const UsageSnapshotParams = z.strictObject({
  provider: UsageProvider,
  scope: z.enum(['orca', 'all']),
  range: z.enum(['7d', '30d', '90d', 'all']),
  limit: z.number().int().min(0).max(1000).optional(),
  includeHistory: z.boolean().optional()
})

export const UsageRefreshParams = z.strictObject({
  provider: UsageProvider,
  force: z.boolean().optional()
})

export const UsageSetEnabledParams = z.strictObject({
  provider: UsageProvider,
  enabled: z.boolean()
})
