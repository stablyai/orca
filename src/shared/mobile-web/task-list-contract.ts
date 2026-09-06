import { z } from 'zod'
import { MobileWebHostedNullableAvatarUrlSchema } from './hosted-avatar-contract'

const RepoIdSchema = z.string().min(1).max(128)
const BoundedStringSchema = z.string().max(4_096)
const UrlSchema = z.string().url().max(4_096)
const OwnerRepoSchema = z
  .object({
    owner: z.string().min(1).max(160),
    repo: z.string().min(1).max(240),
    host: z.string().min(1).max(253).optional()
  })
  .strip()

export const MobileWebTaskGitHubUserSchema = z
  .object({
    login: z.string().min(1).max(160),
    name: z.string().max(240).nullable().optional(),
    avatarUrl: MobileWebHostedNullableAvatarUrlSchema
  })
  .strip()

const GitHubWorkItemSchema = z
  .object({
    id: z.string().min(1).max(240),
    type: z.enum(['issue', 'pr']),
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    title: z.string().max(2_000),
    state: z.enum(['open', 'closed', 'merged', 'draft']),
    url: UrlSchema,
    labels: z.array(z.string().max(240)).max(1_000),
    updatedAt: z.string().max(64),
    author: z.string().max(160).nullable(),
    branchName: z.string().max(512).optional(),
    baseRefName: z.string().max(512).optional(),
    isCrossRepository: z.boolean().optional(),
    additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    changedFiles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    reviewDecision: z.string().max(80).nullable().optional(),
    reviewRequests: z.array(MobileWebTaskGitHubUserSchema).max(1_000).optional(),
    latestReviews: z
      .array(
        z
          .object({
            login: z.string().min(1).max(160),
            state: z.string().max(80).nullable().optional(),
            avatarUrl: MobileWebHostedNullableAvatarUrlSchema
          })
          .strip()
      )
      .max(1_000)
      .optional(),
    checksSummary: z
      .object({
        state: z.enum(['success', 'failure', 'pending', 'none']),
        total: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative()
      })
      .strict()
      .optional(),
    mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).optional(),
    mergeStateStatus: z.string().max(80).nullable().optional(),
    targetId: z.string().min(1).max(128).optional()
  })
  .strip()

const GitHubSourcesSchema = z
  .object({
    issues: OwnerRepoSchema.nullable(),
    prs: OwnerRepoSchema.nullable().optional(),
    upstreamCandidate: OwnerRepoSchema.nullable().optional()
  })
  .strict()

export const MobileWebTaskGitHubListPayloadSchema = z
  .object({
    repoId: RepoIdSchema,
    limit: z.number().int().min(1).max(100),
    query: z.string().max(2_000),
    before: z.string().min(1).max(512).optional()
  })
  .strict()
export const MobileWebTaskGitHubListResultSchema = z
  .object({
    items: z.array(GitHubWorkItemSchema).max(100),
    sources: GitHubSourcesSchema.optional(),
    errors: z
      .object({
        issues: z
          .object({ message: z.string().max(1_000) })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    issueSourceFellBack: z.literal(true).optional()
  })
  .strict()

export const MobileWebTaskGitHubCountPayloadSchema = z
  .object({ repoId: RepoIdSchema, query: z.string().max(2_000) })
  .strict()
export const MobileWebTaskGitHubCountResultSchema = z
  .object({ count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  .strict()

const GitLabWorkItemSchema = z
  .object({
    id: z.string().min(1).max(240),
    type: z.enum(['issue', 'mr']),
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    title: z.string().max(2_000),
    state: z.enum(['opened', 'closed', 'merged', 'locked', 'draft']),
    url: UrlSchema,
    labels: z.array(z.string().max(240)).max(1_000),
    updatedAt: z.string().max(64),
    author: z.string().max(160).nullable(),
    branchName: z.string().max(512).optional(),
    baseRefName: z.string().max(512).optional(),
    isCrossRepository: z.boolean().optional(),
    targetId: z.string().min(1).max(128).optional()
  })
  .strip()

export const MobileWebTaskGitLabListPayloadSchema = z
  .object({
    repoId: RepoIdSchema,
    state: z.enum(['opened', 'merged', 'closed', 'all']),
    page: z.number().int().min(1).max(10_000),
    perPage: z.number().int().min(1).max(100),
    query: z.string().max(2_000).optional()
  })
  .strict()
export const MobileWebTaskGitLabListResultSchema = z
  .object({
    items: z.array(GitLabWorkItemSchema).max(100),
    error: z
      .object({
        type: z.string().max(80).optional(),
        message: z.string().max(1_000)
      })
      .strict()
      .optional()
  })
  .strict()

export const MobileWebTaskGitLabTodosPayloadSchema = z.object({ repoId: RepoIdSchema }).strict()
export const MobileWebTaskGitLabTodosResultSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            actionName: z.string().max(160),
            targetType: z.string().max(160),
            targetIid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
            targetTitle: z.string().max(2_000),
            targetUrl: UrlSchema,
            projectPath: z.string().max(1_024),
            authorUsername: z.string().max(160),
            updatedAt: z.string().max(64),
            state: z.enum(['pending', 'done'])
          })
          .strip()
      )
      .max(1_000)
  })
  .strip()

export const MobileWebTaskLinearIssueSchema = z
  .object({
    id: z.string().min(1).max(160),
    targetId: z.string().min(1).max(128).optional(),
    workspaceId: z.string().min(1).max(160).optional(),
    workspaceName: z.string().max(240).optional(),
    identifier: z.string().min(1).max(160),
    title: z.string().max(2_000),
    description: BoundedStringSchema.optional(),
    url: UrlSchema,
    state: z
      .object({
        name: z.string().max(240),
        type: z.string().max(80),
        color: z.string().max(64)
      })
      .strict(),
    team: z
      .object({
        id: z.string().min(1).max(160),
        name: z.string().max(240),
        key: z.string().max(80)
      })
      .strict(),
    project: z
      .object({
        id: z.string().min(1).max(160),
        name: z.string().max(240),
        url: UrlSchema.optional(),
        color: z.string().max(64).optional()
      })
      .strict()
      .optional(),
    subIssues: z
      .array(
        z
          .object({
            id: z.string().min(1).max(160),
            targetId: z.string().min(1).max(128).optional(),
            identifier: z.string().max(160),
            title: z.string().max(2_000),
            url: UrlSchema
          })
          .strict()
      )
      .max(1_000)
      .optional(),
    labels: z.array(z.string().max(240)).max(1_000),
    labelIds: z.array(z.string().max(160)).max(1_000).optional(),
    assignee: z
      .object({
        id: z.string().max(160).optional(),
        displayName: z.string().max(240)
      })
      .strict()
      .optional(),
    estimate: z.number().finite().nullable().optional(),
    priority: z.number().int().min(0).max(4),
    updatedAt: z.string().max(64)
  })
  .strip()

export const MobileWebTaskLinearListPayloadSchema = z
  .object({
    query: z.string().max(2_000).optional(),
    filter: z.enum(['assigned', 'created', 'all', 'completed']).optional(),
    limit: z.number().int().min(1).max(250),
    workspaceId: z.string().min(1).max(160).optional()
  })
  .strict()
  .refine((value) => Boolean(value.query) !== Boolean(value.filter))
export const MobileWebTaskLinearListResultSchema = z
  .object({ items: z.array(MobileWebTaskLinearIssueSchema).max(250) })
  .strict()

export type MobileWebTaskGitHubListPayload = z.infer<typeof MobileWebTaskGitHubListPayloadSchema>
export type MobileWebTaskGitHubListResult = z.infer<typeof MobileWebTaskGitHubListResultSchema>
export type MobileWebTaskGitHubCountPayload = z.infer<typeof MobileWebTaskGitHubCountPayloadSchema>
export type MobileWebTaskGitLabListPayload = z.infer<typeof MobileWebTaskGitLabListPayloadSchema>
export type MobileWebTaskGitLabListResult = z.infer<typeof MobileWebTaskGitLabListResultSchema>
export type MobileWebTaskGitLabTodosPayload = z.infer<typeof MobileWebTaskGitLabTodosPayloadSchema>
export type MobileWebTaskGitLabTodo = z.infer<
  typeof MobileWebTaskGitLabTodosResultSchema
>['items'][number]
export type MobileWebTaskLinearListPayload = z.infer<typeof MobileWebTaskLinearListPayloadSchema>
export type MobileWebTaskLinearIssue = z.infer<typeof MobileWebTaskLinearIssueSchema>
