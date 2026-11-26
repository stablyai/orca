import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const JiraFavouriteFilterParams = lazyZodSchema(() =>
  z.strictObject({
    siteId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine((siteId) => siteId !== 'all')
  })
)
