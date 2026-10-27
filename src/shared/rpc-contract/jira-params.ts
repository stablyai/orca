import { JiraIssueListFiltersParam } from './jira-quick-filter-params'
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
    siteId: OptionalString,
    strict: z.boolean().optional()
  })
  .optional()

export const Connect = z.object({
  siteUrl: requiredString('Site URL is required'),
  // Self-hosted PAT auth needs no email; connect() enforces it for Cloud.
  email: OptionalPlainString,
  apiToken: requiredString('API token is required'),
  authType: z.enum(['cloud', 'server']).optional()
})

export const SelectSite = z.object({
  siteId: requiredString('Site ID is required')
})

export const SearchIssues = z.object({
  jql: requiredString('Missing JQL'),
  limit: OptionalFiniteNumber,
  siteId: OptionalString,
  strict: z.boolean().optional()
})

export const ListIssues = z
  .object({
    filter: z.enum(VALID_FILTERS).optional(),
    limit: OptionalFiniteNumber,
    siteId: OptionalString,
    strict: z.boolean().optional(),
    filters: JiraIssueListFiltersParam.optional()
  })
  .optional()

export const IssueKey = z.object({
  key: requiredString('Issue key is required'),
  siteId: OptionalString,
  strict: z.boolean().optional(),
  mediaFormat: z.literal('reference').optional()
})

export const AttachmentImage = z.object({
  reference: z.string().uuid(),
  transferId: z.string().uuid()
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
  updates: z
    .object({
      title: OptionalString,
      labels: z.array(z.string()).optional(),
      labelOperations: z
        .object({
          add: z.array(requiredString('Label cannot be empty')).optional(),
          remove: z.array(requiredString('Label cannot be empty')).optional()
        })
        .strict()
        .optional(),
      assigneeAccountId: z.union([z.string(), z.null()]).optional(),
      priorityId: z.union([z.string(), z.null()]).optional(),
      transitionId: OptionalString,
      transitionFields: z.record(z.string(), z.unknown()).optional(),
      transitionComment: z.string().optional()
    })
    .refine((updates) => !(updates.labels && updates.labelOperations), {
      message: 'Pass labels or labelOperations, not both'
    })
})

export const IssueComment = z.object({
  key: requiredString('Issue key is required'),
  body: requiredString('Comment body is required'),
  siteId: OptionalString
})

export const ProjectIssueTypes = z.object({
  projectIdOrKey: requiredString('Project is required'),
  siteId: OptionalString,
  strict: z.boolean().optional()
})

export const ProjectIssueTypeFields = z.object({
  projectIdOrKey: requiredString('Project is required'),
  issueTypeId: requiredString('Issue type is required'),
  siteId: OptionalString,
  strict: z.boolean().optional()
})

export const AssignableUsers = z.object({
  key: requiredString('Issue key is required'),
  query: OptionalPlainString,
  siteId: OptionalString,
  strict: z.boolean().optional()
})

export const UserSearch = z.object({
  query: OptionalPlainString,
  siteId: OptionalString
})

export const ProjectStatusOrder = z.object({
  projectKey: requiredString('Project key is required'),
  siteId: OptionalString
})

export const CancelGenerateIssueSummary = z.object({
  siteId: requiredString('Site ID is required'),
  requestId: z.string().trim().min(1).max(128),
  draftId: z.string().trim().min(1).max(128)
})

export const GenerateIssueSummary = CancelGenerateIssueSummary.extend({
  description: z.string().trim().min(1).max(32_000),
  projectName: z.string().max(255).optional(),
  issueTypeName: z.string().max(255).optional()
})
