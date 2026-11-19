import { z } from 'zod'

export const ProviderRemoteControlParams = z
  .object({
    sessionId: z.string().min(1),
    choice: z.enum(['on', 'off']).optional()
  })
  .strict()
