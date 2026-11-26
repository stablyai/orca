import * as z from 'zod'
import {
  commanderAccount,
  commanderRecurringAnswerChange,
  commanderMemoryIndexQuery,
  commanderMemoryId,
  commanderMemoryRevision,
  commanderMemoryWrite
} from '../commander/memory-contract'

export const CommanderPhoneRecurringAnswersParams = z.strictObject({
  account: commanderAccount,
  change: commanderRecurringAnswerChange.optional()
})
export const CommanderPhoneListParams = z
  .object({
    account: commanderAccount,
    handoffsOnly: z.boolean().optional(),
    after: commanderMemoryIndexQuery.shape.after,
    order: commanderMemoryIndexQuery.shape.order,
    q: commanderMemoryIndexQuery.shape.q,
    includeDeleted: z.boolean().optional(),
    projectId: z.string().max(256).optional()
  })
  .strict()
export const CommanderPhoneReadParams = z
  .object({
    account: commanderAccount,
    pageId: commanderMemoryId,
    version: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1)
      .optional(),
    beforeVersion: z.number().int().positive().optional()
  })
  .strict()
export const CommanderPhoneSaveParams = z
  .object({ account: commanderAccount, write: commanderMemoryWrite })
  .strict()
export const commanderPhoneSummary = commanderMemoryRevision
  .omit({
    body: true,
    links: true,
    createdBy: true
  })
  .extend({ recurringQuestion: z.string().optional() })
export const commanderPhoneStatus = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('enabled'),
    account: commanderAccount,
    handoffs: z.literal(true).optional(),
    handoffSearch: z.literal(true).optional()
  }),
  z.object({ state: z.enum(['signed-out', 'disabled']) })
])
export const commanderPhonePages = z.object({
  pages: z.array(commanderPhoneSummary),
  projects: z.array(z.string()),
  next: z.string().nullable()
})
export const commanderPhonePage = z.object({
  page: commanderMemoryRevision,
  selectedRevision: commanderMemoryRevision.optional(),
  history: z.array(commanderPhoneSummary),
  nextBeforeVersion: z.number().nullable()
})
