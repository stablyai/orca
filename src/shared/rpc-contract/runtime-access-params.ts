import { z } from 'zod'

export const RevokeRuntimeAccessParams = z
  .object({
    deviceId: z.string().uuid('Expected the full device ID from runtime-access list')
  })
  .strict()
