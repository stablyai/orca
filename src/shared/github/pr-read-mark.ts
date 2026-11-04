import { z } from 'zod'

/** A persisted PR read mark; a PR reads as unread again once its row moves past the mark. */
export const PRReadMarkSchema = z.object({
  version: z.number().finite(),
  checks: z.string(),
  state: z.enum(['open', 'closed', 'merged', 'draft'])
})

export type PRReadMark = z.infer<typeof PRReadMarkSchema>

export const PRReadMarksSchema = z.record(z.string(), PRReadMarkSchema)
