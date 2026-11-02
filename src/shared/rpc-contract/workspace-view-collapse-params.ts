import { z } from 'zod'

/**
 * One section's collapse, sent by `ui.setCollapsed`. A retry resends the same opId. `seq` must grow
 * with each change a writer makes, so a client mints a fresh `writer` whenever its counter restarts;
 * reusing one with a reset counter makes the host drop those changes as already settled.
 */
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
