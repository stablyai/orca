import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

export const SiteSelection = z
  .object({
    siteId: OptionalString
  })
  .optional()

export const Connect = z.object({
  siteUrl: requiredString('Site URL is required'),
  apiToken: requiredString('API token is required')
})

export const SelectSite = z.object({
  siteId: requiredString('Site ID is required')
})

export const ListIssues = z
  .object({
    filter: z.enum(['assigned', 'reported', 'all']).optional(),
    limit: OptionalFiniteNumber,
    siteId: OptionalString,
    projectId: OptionalString
  })
  .optional()

export const IssueId = z.object({
  id: requiredString('Issue id is required'),
  siteId: OptionalString
})
