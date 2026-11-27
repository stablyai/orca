import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const UpdaterCheckParams = lazyZodSchema(() =>
  z.object({
    includePrerelease: z.boolean().optional(),
    includePerfPrerelease: z.boolean().optional(),
    ignoreUpdateDelay: z.boolean().optional()
  })
)
