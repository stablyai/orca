import { z } from 'zod'

/** Retry with the same opId; seq grows per writer. Mint a new writer when resetting its counter,
 * or the host will treat new changes as already settled. */
export const SetCollapsedParams = z.object({
  key: z.string().min(1).max(1024),
  collapsed: z.boolean(),
  opId: z.object({
    writer: z.string().min(1).max(128),
    seq: z.number().int().nonnegative()
  })
})

export type SetCollapsedRequest = z.infer<typeof SetCollapsedParams>

/** `applied: false` settles the op too: it already ran, or the same writer changed the key since. */
export type SetCollapsedResult = { collapsed: boolean; applied: boolean }
