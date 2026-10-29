import { z } from 'zod'

export const UpdaterCheckParams = z.object({
  includePrerelease: z.boolean().optional(),
  includePerfPrerelease: z.boolean().optional()
})
