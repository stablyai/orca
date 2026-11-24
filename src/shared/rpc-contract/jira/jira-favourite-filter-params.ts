import { z } from 'zod'

export const JiraFavouriteFilterParams = z.strictObject({
  siteId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((siteId) => siteId !== 'all')
})
