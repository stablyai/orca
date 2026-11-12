import { z } from 'zod'

/** One-launch deletions; an empty edit has the same identity as no edit. */
export const TerminalOptionEditsParam = z
  .object({ effort: z.null().optional() })
  .strict()
  .transform((edit) => (edit.effort === null ? edit : undefined))
