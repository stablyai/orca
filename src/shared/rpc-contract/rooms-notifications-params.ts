import { z } from 'zod'

export const RoomsNotificationsReplayParams = z
  .object({
    afterSequence: z.number().int().nonnegative().nullable().optional(),
    limit: z.number().int().min(1).max(200).default(200)
  })
  .strict()
