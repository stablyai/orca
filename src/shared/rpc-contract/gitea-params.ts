import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

const trimmedRequired = (message: string) => z.string().trim().min(1, message)

export const RepoSelector = z.object({
  repo: requiredString('Missing repo selector')
})

export const MarkNotificationRead = RepoSelector.extend({
  notificationId: z.number().int().positive()
})

export const EmptyParams = z.object({}).optional().default({})

export const GiteaRateLimit = z
  .object({
    force: z.boolean().optional(),
    host: OptionalString
  })
  .optional()
  .default({})

// Callers normalize absent refs to null; optional alone would reject those payloads.
export const GiteaProjectRef = z
  .object({
    host: requiredString('Missing Gitea host'),
    path: requiredString('Missing Gitea project path')
  })
  .nullish()

export const WorkItemsList = RepoSelector.extend({
  state: z.enum(['opened', 'merged', 'closed', 'all']).optional(),
  page: OptionalFiniteNumber,
  perPage: OptionalFiniteNumber,
  query: OptionalString
})

export const IssuesList = RepoSelector.extend({
  state: z.enum(['opened', 'closed', 'all']).optional(),
  assignee: OptionalString,
  limit: OptionalFiniteNumber,
  page: OptionalFiniteNumber
})

export const PullRequestLookup = RepoSelector.extend({
  number: z.number().int().positive()
})

export const PullRequestForBranch = RepoSelector.extend({
  branch: requiredString('Missing branch'),
  linkedPRNumber: z.number().int().positive().nullish()
})

export const CreateIssue = RepoSelector.extend({
  title: trimmedRequired('Missing title'),
  body: z.string()
})

export const IssueUpdate = z.object({
  state: z.enum(['open', 'closed']).optional(),
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
  projectRef: GiteaProjectRef
})

export const UpdatePrState = RepoSelector.extend({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  projectRef: GiteaProjectRef
})

export const UpdatePr = RepoSelector.extend({
  number: z.number().int().positive(),
  updates: z.object({
    title: z.string().optional(),
    body: z.string().optional(),
    addLabels: z.array(z.string()).optional(),
    removeLabels: z.array(z.string()).optional(),
    draft: z.boolean().optional()
  }),
  projectRef: GiteaProjectRef
})

export const UpdatePrReviewers = RepoSelector.extend({
  number: z.number().int().positive(),
  reviewerUsernames: z.array(z.string()),
  projectRef: GiteaProjectRef
})

export const MergePr = RepoSelector.extend({
  number: z.number().int().positive(),
  method: z.enum(['merge', 'squash', 'rebase', 'rebase-merge']).optional(),
  projectRef: GiteaProjectRef
})

export const AddIssueComment = RepoSelector.extend({
  number: z.number().int().positive(),
  body: trimmedRequired('Comment body is required'),
  projectRef: GiteaProjectRef
})

export const AddPRComment = RepoSelector.extend({
  number: z.number().int().positive(),
  body: trimmedRequired('Comment body is required'),
  projectRef: GiteaProjectRef
})

export const AddPRInlineComment = RepoSelector.extend({
  number: z.number().int().positive(),
  input: z.object({
    body: trimmedRequired('Comment body is required'),
    path: trimmedRequired('File path is required'),
    line: z.number().int().positive(),
    headSha: trimmedRequired('Head SHA is required'),
    replyToCommentId: z.string().optional()
  }),
  projectRef: GiteaProjectRef
})

export const ResolvePRDiscussion = RepoSelector.extend({
  number: z.number().int().positive(),
  discussionId: requiredString('Discussion id is required'),
  resolved: z.boolean(),
  projectRef: GiteaProjectRef
})

export const SubmitPRReview = RepoSelector.extend({
  number: z.number().int().positive(),
  decision: z.enum(['approve', 'request_changes']),
  body: z.string().optional(),
  projectRef: GiteaProjectRef
})

export const JobTrace = RepoSelector.extend({
  jobId: z.number().int().positive(),
  projectRef: GiteaProjectRef,
  logExcerpt: z.boolean().optional()
})

export const WorkItemDetails = RepoSelector.extend({
  number: z.number().int().positive(),
  type: z.enum(['issue', 'pr']),
  projectRef: GiteaProjectRef,
  includeReviewDetails: z.boolean().optional()
})

export const WorkItemByPath = RepoSelector.extend({
  host: requiredString('Missing Gitea host'),
  path: requiredString('Missing Gitea project path'),
  number: z.number().int().positive(),
  type: z.enum(['issue', 'pr'])
})
