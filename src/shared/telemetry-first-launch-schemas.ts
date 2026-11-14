import { z } from 'zod'

export const firstLaunchLayoutSchema = z.enum(['home-workspace', 'project-picker'])

/** Enqueued by main, normally once per install and best effort; receipt is not guaranteed and repeats are possible. */
export const firstLaunchLayoutShownSchema = z
  .object({
    layout: firstLaunchLayoutSchema,
    fresh_profile: z.boolean()
  })
  .strict()
