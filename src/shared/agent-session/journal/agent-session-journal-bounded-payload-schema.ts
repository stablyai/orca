import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/** A large tool or diff body kept as its head plus a digest of the whole. */
export const BoundedPayload = lazyZodSchema(() =>
  z.object({
    head: z.string(),
    byteLength: z.number(),
    digest: z.string(),
    truncated: z.boolean()
  })
)

/** A provider frame carried beside a block, its payload bounded. */
export const ProviderFrame = lazyZodSchema(() =>
  z.object({
    provider: z.string(),
    kind: z.string(),
    payload: BoundedPayload
  })
)
