import { z } from 'zod'

export const ClientCapabilitiesUpdate = z
  .object({
    clientCapabilities: z.array(z.string().min(1).max(128)).max(64)
  })
  .strict()
