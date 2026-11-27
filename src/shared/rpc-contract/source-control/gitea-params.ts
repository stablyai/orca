import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalString, requiredString } from '../rpc-param-primitives'

// One schema per Gitea call, shared by the desktop IPC handlers and the runtime RPC methods.

export const GiteaRepoSelector = lazyZodSchema(() =>
  z.object({
    repo: requiredString('Missing repo selector')
  })
)

const IssueNumber = lazyZodSchema(() => z.number().int().positive())
const PositiveIds = lazyZodSchema(() => z.array(z.number().int().positive()))

export const GiteaServerIdParams = lazyZodSchema(() =>
  z.object({ serverId: OptionalString }).optional().default({})
)

export const GiteaConnectParams = lazyZodSchema(() =>
  z.object({
    baseUrl: requiredString('Missing Gitea server URL'),
    token: requiredString('Missing Gitea access token')
  })
)

export const GiteaWorkItemsList = lazyZodSchema(() =>
  GiteaRepoSelector.extend({
    filter: z.enum(['assigned', 'created', 'all', 'closed']).optional(),
    kind: z.enum(['issues', 'pulls']).optional(),
    limit: z
      .number()
      .int()
      .optional()
      .transform((value) => clampLimit(value))
  })
)

export const GiteaIssueByNumber = lazyZodSchema(() =>
  GiteaRepoSelector.extend({
    number: IssueNumber
  })
)

export const GiteaCreateIssue = lazyZodSchema(() =>
  GiteaRepoSelector.extend({
    title: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1, 'Title is required.')),
    body: z.string().optional(),
    assignees: z.array(z.string()).optional(),
    labelIds: PositiveIds.optional()
  })
)

export const GiteaIssueUpdate = lazyZodSchema(() =>
  z.object({
    title: z.string().optional(),
    body: z.string().optional(),
    state: z.enum(['open', 'closed']).optional(),
    assignees: z.array(z.string()).optional(),
    labelIds: PositiveIds.optional()
  })
)

export const GiteaUpdateIssue = lazyZodSchema(() =>
  GiteaRepoSelector.extend({
    number: IssueNumber,
    updates: GiteaIssueUpdate
  })
)

export const GiteaAddIssueComment = lazyZodSchema(() =>
  GiteaRepoSelector.extend({
    number: IssueNumber,
    body: z.string().refine((value) => value.trim().length > 0, 'Comment body is required.')
  })
)

export const GiteaPullRequestFileContents = lazyZodSchema(() =>
  GiteaRepoSelector.extend({
    path: requiredString('Missing file path'),
    oldPath: OptionalString,
    status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'changed']),
    baseSha: z.string(),
    headSha: z.string()
  })
)

export const GiteaPullRequestChecks = lazyZodSchema(() =>
  GiteaRepoSelector.extend({
    headSha: requiredString('Missing head commit')
  })
)

export const GiteaMergePullRequest = lazyZodSchema(() =>
  GiteaRepoSelector.extend({
    number: IssueNumber,
    method: z.enum(['merge', 'rebase', 'squash']).optional().default('merge')
  })
)

export const GiteaAddPullRequestReviewComment = lazyZodSchema(() =>
  GiteaRepoSelector.extend({
    number: IssueNumber,
    path: requiredString('File path is required.'),
    line: z.number().int().positive(),
    body: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1, 'Comment body is required.'))
  })
)

function clampLimit(value: number | undefined): number {
  return Math.min(Math.max(1, value ?? 30), 100)
}
