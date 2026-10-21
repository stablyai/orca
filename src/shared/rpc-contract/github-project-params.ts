import { z } from 'zod'
import { SlugRepo } from './github-repo-target-params'
import { OptionalString, requiredString } from './rpc-param-primitives'
import { IssueUpdate } from './github-issue-update-params'

export const SlugAssignableUsers = SlugRepo.extend({
  seedLogins: z.array(z.string()).optional()
})

export const ProjectOwnerType = z.enum(['organization', 'user'])

export const ProjectViewTable = z.object({
  owner: requiredString('Missing owner'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  ownerType: ProjectOwnerType,
  projectNumber: z.number().int().positive(),
  viewId: OptionalString,
  viewNumber: z.number().int().positive().optional(),
  viewName: OptionalString,
  queryOverride: OptionalString
})

export const ProjectWorkItemDetailsBySlug = SlugRepo.extend({
  number: z.number().int().positive(),
  type: z.enum(['issue', 'pr'])
})

export const ProjectRef = z.object({
  input: requiredString('Missing project reference'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString
})

export const ProjectViews = z.object({
  owner: requiredString('Missing owner'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  ownerType: ProjectOwnerType,
  projectNumber: z.number().int().positive()
})

export const ProjectItemField = z.object({
  projectId: requiredString('Missing project ID'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  itemId: requiredString('Missing item ID'),
  fieldId: requiredString('Missing field ID'),
  value: z.any()
})

export const ClearProjectItemField = z.object({
  projectId: requiredString('Missing project ID'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  itemId: requiredString('Missing item ID'),
  fieldId: requiredString('Missing field ID')
})

export const SlugIssueUpdate = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  number: z.number().int().positive(),
  updates: IssueUpdate
})

export const SlugPullRequestUpdate = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  number: z.number().int().positive(),
  updates: z.object({
    state: z.enum(['open', 'closed']).optional(),
    title: OptionalString,
    body: OptionalString
  })
})

export const SlugIssueTypeUpdate = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  number: z.number().int().positive(),
  issueTypeId: z.string().nullable()
})

export const SlugIssueComment = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  number: z.number().int().positive(),
  body: requiredString('Comment body required')
})

export const SlugIssueCommentEdit = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  commentId: z.number().int().positive(),
  body: requiredString('Comment body required')
})

export const SlugIssueCommentDelete = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  commentId: z.number().int().positive()
})

export const GithubProjectListAccessibleParams = z.object({ host: OptionalString })
