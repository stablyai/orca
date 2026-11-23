import { z } from 'zod'
import { OptionalPositiveInt, requiredString } from '../rpc-param-primitives'

export const AzureBoardsRepo = z.object({
  repo: requiredString('Missing repo selector')
})

export const AzureBoardsWorkItem = AzureBoardsRepo.extend({
  id: z.number().int().positive()
})

export const AzureBoardsWorkItemComments = AzureBoardsWorkItem.extend({
  limit: OptionalPositiveInt
})

export const AzureBoardsSearch = AzureBoardsRepo.extend({
  wiql: requiredString('Missing WIQL query'),
  limit: OptionalPositiveInt
})

// Writes carry the caller's explicit confirmation, so no client changes a work item by default.
const Confirmed = { confirm: z.literal(true) }

export const AzureBoardsWorkItemCommentAdd = AzureBoardsWorkItem.extend({
  ...Confirmed,
  text: requiredString('Missing comment text').pipe(z.string().max(10_000))
})

export const AzureBoardsWorkItemStateSet = AzureBoardsWorkItem.extend({
  ...Confirmed,
  state: requiredString('Missing state')
})

export const AzureBoardsWorkItemAssigneeSet = AzureBoardsWorkItem.extend({
  ...Confirmed,
  // An email or account name, `@me`, or null to unassign.
  assignee: z.string().trim().min(1).max(320).nullable()
})
