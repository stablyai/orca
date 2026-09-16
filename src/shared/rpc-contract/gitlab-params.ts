import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

export const RepoSelector = z.object({
  repo: requiredString('Missing repo selector')
})

export const EmptyParams = z.object({}).optional().default({})

export const GitLabRateLimit = z
  .object({
    force: z.boolean().optional(),
    host: OptionalString
  })
  .optional()
  .default({})

// nullish, not optional: renderer callers normalise a missing ref to `null`
// (`item.projectRef ?? null`), which a bare `.optional()` would reject outright.
export const GitLabProjectRef = z
  .object({
    host: requiredString('Missing GitLab host'),
    path: requiredString('Missing GitLab project path')
  })
  .nullish()

export const WorkItemsList = RepoSelector.extend({
  state: z.enum(['opened', 'merged', 'closed', 'all']).optional(),
  page: OptionalFiniteNumber,
  perPage: OptionalFiniteNumber,
  query: OptionalString
})

export const IssuesList = RepoSelector.extend({
  state: z.unknown().optional(),
  assignee: OptionalString,
  limit: OptionalFiniteNumber,
  page: OptionalFiniteNumber
})

export const CreateIssue = RepoSelector.extend({
  title: requiredString('Missing title'),
  body: z.string()
})

export const IssueUpdate = z.object({
  state: z.enum(['opened', 'closed']).optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  addLabels: z.array(z.string()).optional(),
  removeLabels: z.array(z.string()).optional(),
  addAssignees: z.array(z.string()).optional(),
  removeAssignees: z.array(z.string()).optional()
})

export const UpdateIssue = RepoSelector.extend({
  number: z.number().int().positive(),
  updates: IssueUpdate,
  projectRef: GitLabProjectRef
})

export const UpdateMrState = RepoSelector.extend({
  iid: z.number().int().positive(),
  state: z.enum(['opened', 'closed']),
  projectRef: GitLabProjectRef
})

export const UpdateMr = RepoSelector.extend({
  iid: z.number().int().positive(),
  updates: z.object({
    title: z.string().optional(),
    body: z.string().optional(),
    addLabels: z.array(z.string()).optional(),
    removeLabels: z.array(z.string()).optional(),
    readyForReview: z.literal(true).optional()
  }),
  projectRef: GitLabProjectRef
})

export const UpdateMrReviewers = RepoSelector.extend({
  iid: z.number().int().positive(),
  reviewerIds: z.array(z.number().int().nonnegative()),
  projectRef: GitLabProjectRef
})

export const MergeMr = RepoSelector.extend({
  iid: z.number().int().positive(),
  method: z.enum(['merge', 'squash', 'rebase']).optional(),
  projectRef: GitLabProjectRef
})

export const AddIssueComment = RepoSelector.extend({
  number: z.number().int().positive(),
  body: requiredString('Comment body is required'),
  projectRef: GitLabProjectRef
})

export const AddMRComment = RepoSelector.extend({
  iid: z.number().int().positive(),
  body: requiredString('Comment body is required'),
  projectRef: GitLabProjectRef
})

export const AddMRInlineComment = RepoSelector.extend({
  iid: z.number().int().positive(),
  input: z.object({
    body: requiredString('Comment body is required'),
    path: requiredString('File path is required'),
    oldPath: z.string().optional(),
    line: z.number().int().positive(),
    baseSha: requiredString('Base SHA is required'),
    startSha: requiredString('Start SHA is required'),
    headSha: requiredString('Head SHA is required')
  }),
  projectRef: GitLabProjectRef
})

export const ResolveMRDiscussion = RepoSelector.extend({
  iid: z.number().int().positive(),
  discussionId: requiredString('Discussion id is required'),
  resolved: z.boolean(),
  projectRef: GitLabProjectRef
})

export const JobTrace = RepoSelector.extend({
  jobId: z.number().int().positive(),
  projectRef: GitLabProjectRef,
  // Why: raw CI traces routinely exceed the 1 MB transport frame cap, so callers
  // that only render an excerpt ask main to bound it before it crosses the wire.
  logExcerpt: z.boolean().optional()
})

export const RetryJob = RepoSelector.extend({
  jobId: z.number().int().positive(),
  projectRef: GitLabProjectRef
})

export const WorkItemDetails = RepoSelector.extend({
  iid: z.number().int().positive(),
  type: z.enum(['issue', 'mr']),
  projectRef: GitLabProjectRef
})

export const WorkItemByPath = RepoSelector.extend({
  host: requiredString('Missing GitLab host'),
  path: requiredString('Missing GitLab project path'),
  iid: z.number().int().positive(),
  type: z.enum(['issue', 'mr'])
})
