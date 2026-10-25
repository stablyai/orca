import { z } from 'zod'

export const UpdaterCheckParams = z.object({
  includePrerelease: z.boolean().optional(),
  includePerfPrerelease: z.boolean().optional()
})

export const UpdaterInstallParams = z
  .object({ expectedTargetVersion: z.string().optional() })
  .nullish()
