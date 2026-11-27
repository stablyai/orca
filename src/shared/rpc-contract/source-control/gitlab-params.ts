import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../rpc-param-primitives'

export const RepoSelector = lazyZodSchema(() =>
  z.object({
    repo: requiredString('Missing repo selector')
  })
)

export const EmptyParams = lazyZodSchema(() => z.object({}).optional().default({}))

export const GitLabRateLimit = lazyZodSchema(() =>
  z
    .object({
      force: z.boolean().optional(),
      host: OptionalString
    })
    .optional()
    .default({})
)

// Callers normalize absent refs to null; optional alone would reject those payloads.
export const GitLabProjectRef = lazyZodSchema(() =>
  z
    .object({
      host: requiredString('Missing GitLab host'),
      path: requiredString('Missing GitLab project path')
    })
    .nullish()
)

export const WorkItemsList = lazyZodSchema(() =>
  RepoSelector.extend({
    state: z.enum(['opened', 'merged', 'closed', 'all']).optional(),
    page: OptionalFiniteNumber,
    perPage: OptionalFiniteNumber,
    query: OptionalString
  })
)

export const MergeRequestsList = lazyZodSchema(() =>
  WorkItemsList.extend({
    involvement: z.enum(['authored', 'reviewing']).optional()
  })
)

export const IssuesList = lazyZodSchema(() =>
  RepoSelector.extend({
    state: z.unknown().optional(),
    assignee: OptionalString,
    limit: OptionalFiniteNumber,
    page: OptionalFiniteNumber
  })
)

export const CreateIssue = lazyZodSchema(() =>
  RepoSelector.extend({
    title: requiredString('Missing title'),
    body: z.string()
  })
)

export const IssueUpdate = lazyZodSchema(() =>
  z.object({
    state: z.enum(['opened', 'closed']).optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    addLabels: z.array(z.string()).optional(),
    removeLabels: z.array(z.string()).optional(),
    addAssignees: z.array(z.string()).optional(),
    removeAssignees: z.array(z.string()).optional()
  })
)

export const UpdateIssue = lazyZodSchema(() =>
  RepoSelector.extend({
    number: z.number().int().positive(),
    updates: IssueUpdate,
    projectRef: GitLabProjectRef
  })
)

export const UpdateMrState = lazyZodSchema(() =>
  RepoSelector.extend({
    iid: z.number().int().positive(),
    state: z.enum(['opened', 'closed']),
    projectRef: GitLabProjectRef
  })
)

export const UpdateMr = lazyZodSchema(() =>
  RepoSelector.extend({
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
)

export const UpdateMrReviewers = lazyZodSchema(() =>
  RepoSelector.extend({
    iid: z.number().int().positive(),
    reviewerIds: z.array(z.number().int().nonnegative()),
    projectRef: GitLabProjectRef
  })
)

export const MergeMr = lazyZodSchema(() =>
  RepoSelector.extend({
    iid: z.number().int().positive(),
    method: z.enum(['merge', 'squash', 'rebase']).optional(),
    projectRef: GitLabProjectRef
  })
)

export const AddIssueComment = lazyZodSchema(() =>
  RepoSelector.extend({
    number: z.number().int().positive(),
    body: requiredString('Comment body is required'),
    projectRef: GitLabProjectRef
  })
)

export const AddMRComment = lazyZodSchema(() =>
  RepoSelector.extend({
    iid: z.number().int().positive(),
    body: requiredString('Comment body is required'),
    projectRef: GitLabProjectRef
  })
)

export const AddMRInlineComment = lazyZodSchema(() =>
  RepoSelector.extend({
    iid: z.number().int().positive(),
    input: z.object({
      body: requiredString('Comment body is required'),
      path: requiredString('File path is required'),
      oldPath: z.string().optional(),
      line: z.number().int().positive(),
      oldLine: z.number().int().positive().optional(),
      baseSha: requiredString('Base SHA is required'),
      startSha: requiredString('Start SHA is required'),
      headSha: requiredString('Head SHA is required')
    }),
    projectRef: GitLabProjectRef
  })
)

export const ResolveMRDiscussion = lazyZodSchema(() =>
  RepoSelector.extend({
    iid: z.number().int().positive(),
    discussionId: requiredString('Discussion id is required'),
    resolved: z.boolean(),
    projectRef: GitLabProjectRef
  })
)

export const JobTrace = lazyZodSchema(() =>
  RepoSelector.extend({
    jobId: z.number().int().positive(),
    projectRef: GitLabProjectRef,
    // CI traces exceed the 1 MB frame cap; excerpt callers need the host to bound them before transport.
    logExcerpt: z.boolean().optional()
  })
)

export const RetryJob = lazyZodSchema(() =>
  RepoSelector.extend({
    jobId: z.number().int().positive(),
    projectRef: GitLabProjectRef
  })
)

export const WorkItemDetails = lazyZodSchema(() =>
  RepoSelector.extend({
    iid: z.number().int().positive(),
    type: z.enum(['issue', 'mr']),
    projectRef: GitLabProjectRef,
    includeReviewDetails: z.boolean().optional(),
    // Omitted means true so older phones keep author marks; desktop sends false to skip the `glab api user` read.
    markViewerComments: z.boolean().optional()
  })
)

export const WorkItemByPath = lazyZodSchema(() =>
  RepoSelector.extend({
    host: requiredString('Missing GitLab host'),
    path: requiredString('Missing GitLab project path'),
    iid: z.number().int().positive(),
    type: z.enum(['issue', 'mr'])
  })
)
