import { z } from 'zod'

export const UsageSummaryParams = z
  .object({
    range: z.enum(['7d', '30d', '90d', 'all']).default('30d'),
    scope: z.enum(['orca', 'all']).default('all')
  })
  .default({ range: '30d', scope: 'all' })
