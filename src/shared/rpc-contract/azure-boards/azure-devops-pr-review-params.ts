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
