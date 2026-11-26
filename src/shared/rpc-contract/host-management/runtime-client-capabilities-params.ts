import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const ClientCapabilitiesUpdate = lazyZodSchema(() =>
  z
    .object({
      clientCapabilities: z.array(z.string().min(1).max(128)).max(64)
    })
    .strict()
)
