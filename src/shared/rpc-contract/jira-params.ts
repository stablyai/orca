import { z } from 'zod'
import {
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  requiredString
} from './rpc-param-primitives'

export const VALID_FILTERS = ['assigned', 'reported', 'all', 'done'] as const

export const SiteSelection = z
  .object({
    siteId: OptionalString
  })
  .optional()

export const Connect = z.object({
  siteUrl: requiredString('Site URL is required'),
  // Self-hosted PAT auth needs no email; connect() enforces it for Cloud.
  email: OptionalPlainString,
  apiToken: requiredString('API token is required'),
  authType: z.enum(['cloud', 'cloud-scoped', 'server']).optional()
})

export const SelectSite = z.object({
  siteId: requiredString('Site ID is required')
})

export const SearchIssues = z.object({
  jql: requiredString('Missing JQL'),
  limit: OptionalFiniteNumber,
  siteId: OptionalString
})

export const ListIssues = z
  .object({
    filter: z.enum(VALID_FILTERS).optional(),
    limit: OptionalFiniteNumber,
    siteId: OptionalString
  })
  .optional()

export const IssueKey = z.object({
  key: requiredString('Issue key is required'),
  siteId: OptionalString
})

export const CreateIssue = z.object({
  siteId: OptionalString,
  projectId: requiredString('Project is required'),
  issueTypeId: requiredString('Issue type is required'),
  title: requiredString('Title is required'),
  description: OptionalPlainString,
  customFields: z.record(z.string(), z.unknown()).optional(),
  userFieldKeys: z.array(z.string()).optional()
})

export const IssueUpdate = z.object({
  key: requiredString('Issue key is required'),
  siteId: OptionalString,
  updates: z.object({
    title: OptionalString,
    labels: z.array(z.string()).optional(),
    assigneeAccountId: z.union([z.string(), z.null()]).optional(),
    priorityId: z.union([z.string(), z.null()]).optional(),
    transitionId: OptionalString
  })
})

export const IssueComment = z.object({
  key: requiredString('Issue key is required'),
  body: requiredString('Comment body is required'),
  siteId: OptionalString
})

export const ProjectIssueTypes = z.object({
  projectIdOrKey: requiredString('Project is required'),
  siteId: OptionalString
})

export const ProjectIssueTypeFields = z.object({
  projectIdOrKey: requiredString('Project is required'),
  issueTypeId: requiredString('Issue type is required'),
  siteId: OptionalString
})

export const AssignableUsers = z.object({
  key: requiredString('Issue key is required'),
  query: OptionalPlainString,
  siteId: OptionalString
})

export const UserSearch = z.object({
  query: OptionalPlainString,
  siteId: OptionalString
})

export const ProjectStatusOrder = z.object({
  projectKey: requiredString('Project key is required'),
  siteId: OptionalString
})
