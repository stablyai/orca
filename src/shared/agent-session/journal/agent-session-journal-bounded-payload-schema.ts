import * as z from 'zod'

/** A large tool or diff body kept as its head plus a digest of the whole. */
export const BoundedPayload = z.object({
  head: z.string(),
  byteLength: z.number(),
  digest: z.string(),
  truncated: z.boolean()
})

/** A provider frame carried beside a block, its payload bounded. */
export const ProviderFrame = z.object({
  provider: z.string(),
  kind: z.string(),
  payload: BoundedPayload
})
