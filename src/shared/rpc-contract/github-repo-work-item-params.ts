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
  // Preserve Enterprise host through parsing for host-qualified gh requests.
  host: OptionalString,
  number: z.number().int().positive(),
  type: z.enum(['issue', 'pr']),
  // Older hosts strip it and answer with the full lookup.
  preview: z.boolean().optional()
})

export const WorkItemDetails = WorkItem

export const WorkItemsCount = RepoSelector.extend({
  query: OptionalString
})

export const RateLimit = z.object({
  force: z.boolean().optional()
})
