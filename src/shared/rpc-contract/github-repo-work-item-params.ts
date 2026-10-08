import { z } from 'zod'
import { RepoSelector } from './github-repo-target-params'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

export const WorkItemsList = RepoSelector.extend({
  limit: OptionalFiniteNumber,
  query: OptionalString,
  page: z.number().int().positive().optional(),
  noCache: z.boolean().optional()
})

export const IssuesList = RepoSelector.extend({
  limit: OptionalFiniteNumber
})

export const WorkItem = RepoSelector.extend({
  number: z.number().int().positive(),
  type: z.enum(['issue', 'pr']).optional()
})

export const WorkItemByOwnerRepo = RepoSelector.extend({
  owner: requiredString('Missing owner'),
  ownerRepo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  number: z.number().int().positive(),
  type: z.enum(['issue', 'pr'])
})

export const WorkItemDetails = WorkItem

export const WorkItemsCount = RepoSelector.extend({
  query: OptionalString
})

export const RateLimit = z.object({
  force: z.boolean().optional()
})
