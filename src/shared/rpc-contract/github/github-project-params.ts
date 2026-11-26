import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { SlugRepo } from './github-repo-target-params'
import { OptionalString, requiredString } from '../rpc-param-primitives'
import { IssueUpdate } from './github-issue-update-params'

export const SlugAssignableUsers = SlugRepo.extend({
  seedLogins: z.array(z.string()).optional()
})

export const ProjectOwnerType = lazyZodSchema(() => z.enum(['organization', 'user']))

export const ProjectViewTable = lazyZodSchema(() =>
  z.object({
    owner: requiredString('Missing owner'),
    // Preserve Enterprise host through Zod parsing so gh requests target the correct host.
    host: OptionalString,
    ownerType: ProjectOwnerType,
    projectNumber: z.number().int().positive(),
    viewId: OptionalString,
    viewNumber: z.number().int().positive().optional(),
    viewName: OptionalString,
    queryOverride: OptionalString
  })
)

export const ProjectWorkItemDetailsBySlug = SlugRepo.extend({
  number: z.number().int().positive(),
  type: z.enum(['issue', 'pr'])
})

export const ProjectRef = lazyZodSchema(() =>
  z.object({
    input: requiredString('Missing project reference'),
    host: OptionalString
  })
)

export const ProjectViews = lazyZodSchema(() =>
  z.object({
    owner: requiredString('Missing owner'),
    host: OptionalString,
    ownerType: ProjectOwnerType,
    projectNumber: z.number().int().positive()
  })
)

export const ProjectItemField = lazyZodSchema(() =>
  z.object({
    projectId: requiredString('Missing project ID'),
    host: OptionalString,
    itemId: requiredString('Missing item ID'),
    fieldId: requiredString('Missing field ID'),
    value: z.any()
  })
)

export const ClearProjectItemField = lazyZodSchema(() =>
  z.object({
    projectId: requiredString('Missing project ID'),
    host: OptionalString,
    itemId: requiredString('Missing item ID'),
    fieldId: requiredString('Missing field ID')
  })
)

export const SlugIssueUpdate = lazyZodSchema(() =>
  z.object({
    owner: requiredString('Missing owner'),
    repo: requiredString('Missing repo'),
    host: OptionalString,
    number: z.number().int().positive(),
    updates: IssueUpdate
  })
)

export const SlugPullRequestUpdate = lazyZodSchema(() =>
  z.object({
    owner: requiredString('Missing owner'),
    repo: requiredString('Missing repo'),
    host: OptionalString,
    number: z.number().int().positive(),
    updates: z.object({
      state: z.enum(['open', 'closed']).optional(),
      title: OptionalString,
      body: OptionalString
    })
  })
)

export const SlugIssueTypeUpdate = lazyZodSchema(() =>
  z.object({
    owner: requiredString('Missing owner'),
    repo: requiredString('Missing repo'),
    host: OptionalString,
    number: z.number().int().positive(),
    issueTypeId: z.string().nullable()
  })
)

export const SlugIssueComment = lazyZodSchema(() =>
  z.object({
    owner: requiredString('Missing owner'),
    repo: requiredString('Missing repo'),
    host: OptionalString,
    number: z.number().int().positive(),
    body: requiredString('Comment body required')
  })
)

export const SlugIssueCommentEdit = lazyZodSchema(() =>
  z.object({
    owner: requiredString('Missing owner'),
    repo: requiredString('Missing repo'),
    host: OptionalString,
    commentId: z.number().int().positive(),
    body: requiredString('Comment body required')
  })
)

export const SlugIssueCommentDelete = lazyZodSchema(() =>
  z.object({
    owner: requiredString('Missing owner'),
    repo: requiredString('Missing repo'),
    host: OptionalString,
    commentId: z.number().int().positive()
  })
)

export const GithubProjectListAccessibleParams = lazyZodSchema(() =>
  z.object({ host: OptionalString })
)
