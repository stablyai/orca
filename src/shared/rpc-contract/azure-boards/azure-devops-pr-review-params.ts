import { z } from 'zod'
import { requiredString } from '../rpc-param-primitives'
import { AzureBoardsRepo } from './azure-boards-params'

export const AzureDevOpsPr = AzureBoardsRepo.extend({
  id: z.number().int().positive()
})

export const AzureDevOpsPrFiles = AzureDevOpsPr.extend({
  sinceIteration: z.number().int().min(0).optional()
})

export const AzureDevOpsPrBranch = AzureBoardsRepo.extend({
  branch: requiredString('Missing branch name')
})

// Writes carry the caller's explicit confirmation, so no client posts by default.
const Confirmed = { confirm: z.literal(true) }

export const AzureDevOpsPrComment = AzureDevOpsPr.extend({
  ...Confirmed,
  body: requiredString('Missing comment body').pipe(z.string().max(10_000)),
  threadId: z.number().int().positive().optional(),
  filePath: z.string().trim().min(1).max(1000).optional(),
  line: z.number().int().positive().optional()
})

export const AzureDevOpsPrVote = AzureDevOpsPr.extend({
  ...Confirmed,
  vote: z.union([z.literal(10), z.literal(5), z.literal(0), z.literal(-5)])
})
