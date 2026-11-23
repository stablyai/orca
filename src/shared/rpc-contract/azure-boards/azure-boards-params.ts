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
