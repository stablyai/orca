import { z } from 'zod'
import {
  MobileWebHostedNullableAvatarUrlSchema,
  MobileWebHostedOptionalAvatarUrlSchema
} from './hosted-avatar-contract'
import { MobileWebTaskGitHubUserSchema, MobileWebTaskLinearIssueSchema } from './task-list-contract'

const RepoIdSchema = z.string().min(1).max(128)
const BoundedBodySchema = z.string().max(192 * 1024)
const UrlSchema = z.string().url().max(4_096)

export const MobileWebTaskDetailCommentSchema = z
  .object({
    id: z.union([z.string().min(1).max(240), z.number().int().nonnegative()]),
    author: z.string().max(240).optional(),
    authorAvatarUrl: MobileWebHostedOptionalAvatarUrlSchema,
    user: z
      .object({ displayName: z.string().max(240).optional() })
      .strip()
      .optional(),
    isBot: z.boolean().optional(),
    body: z.string().max(64 * 1024),
    createdAt: z.string().max(64).optional(),
    url: UrlSchema.optional(),
    reactions: z
      .array(
        z
          .object({
            content: z.enum([
              'thumbs_up',
              'thumbs_down',
              'laugh',
              'confused',
              'heart',
              'hooray',
              'rocket',
              'eyes'
            ]),
            count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
          })
          .strict()
      )
      .max(64)
      .optional(),
    path: z.string().max(4_096).optional(),
    line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    startLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    threadId: z.string().min(1).max(512).optional(),
    isResolved: z.boolean().optional()
  })
  .strip()

const GitHubDetailFileSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    oldPath: z.string().max(4_096).optional(),
    status: z
      .enum(['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'])
      .optional(),
    additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    isBinary: z.boolean().optional(),
    viewerViewedState: z.enum(['DISMISSED', 'VIEWED', 'UNVIEWED']).optional()
  })
  .strip()

export const MobileWebTaskGitHubDetailCheckSchema = z
  .object({
    name: z.string().max(512),
    status: z.string().max(80),
    conclusion: z.string().max(80).nullable().optional(),
    url: UrlSchema.nullable().optional()
  })
  .strip()

export const MobileWebTaskGitHubLabelsPayloadSchema = z.object({ repoId: RepoIdSchema }).strict()
export const MobileWebTaskGitHubLabelsResultSchema = z
  .object({ labels: z.array(z.string().max(240)).max(1_000) })
  .strict()

export const MobileWebTaskGitHubUsersPayloadSchema = z.object({ repoId: RepoIdSchema }).strict()
export const MobileWebTaskGitHubUsersResultSchema = z
  .object({ users: z.array(MobileWebTaskGitHubUserSchema).max(1_000) })
  .strict()

export const MobileWebTaskGitHubDetailPayloadSchema = z
  .object({
    repoId: RepoIdSchema,
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.enum(['issue', 'pr'])
  })
  .strict()
export const MobileWebTaskGitHubDetailResultSchema = z
  .object({
    body: BoundedBodySchema,
    comments: z.array(MobileWebTaskDetailCommentSchema).max(1_000),
    labels: z.array(z.string().max(240)).max(1_000).optional(),
    assignees: z.array(z.string().max(240)).max(1_000),
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
    headSha: z.string().max(160).optional(),
    baseSha: z.string().max(160).optional(),
    pullRequestId: z.string().max(240).optional(),
    checks: z.array(MobileWebTaskGitHubDetailCheckSchema).max(1_000),
    files: z.array(GitHubDetailFileSchema).max(2_000)
  })
  .strict()

export const MobileWebTaskGitLabDetailPayloadSchema = z
  .object({ targetId: z.string().min(1).max(128) })
  .strict()
export const MobileWebTaskGitLabDetailResultSchema = z
  .object({
    body: BoundedBodySchema,
    comments: z.array(MobileWebTaskDetailCommentSchema).max(1_000),
    labels: z.array(z.string().max(240)).max(1_000).optional(),
    assignees: z.array(z.string().max(240)).max(1_000),
    item: z
      .object({ mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).optional() })
      .strip()
      .optional(),
    reviewers: z.array(z.unknown()).max(1_000).optional(),
    approvalState: z
      .object({
        approvalsRequired: z.number().int().nonnegative().nullable(),
        approvalsLeft: z.number().int().nonnegative().nullable()
      })
      .strip()
      .optional(),
    pipelineJobs: z
      .array(
        z
          .object({
            id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
            name: z.string().max(512),
            stage: z.string().max(240),
            status: z.string().max(80),
            webUrl: UrlSchema.nullable().optional(),
            duration: z.number().finite().nonnegative().nullable().optional()
          })
          .strip()
      )
      .max(1_000)
  })
  .strict()

export const MobileWebTaskLinearDetailPayloadSchema = z
  .object({ targetId: z.string().min(1).max(128) })
  .strict()
export const MobileWebTaskLinearDetailResultSchema = z
  .object({
    issue: MobileWebTaskLinearIssueSchema,
    comments: z.array(MobileWebTaskDetailCommentSchema).max(1_000)
  })
  .strict()

export type MobileWebTaskDetailComment = z.infer<typeof MobileWebTaskDetailCommentSchema>
export type MobileWebTaskGitHubUser = z.infer<typeof MobileWebTaskGitHubUserSchema>
export type MobileWebTaskGitHubDetailPayload = z.infer<
  typeof MobileWebTaskGitHubDetailPayloadSchema
>
export type MobileWebTaskGitHubDetailResult = z.infer<typeof MobileWebTaskGitHubDetailResultSchema>
export type MobileWebTaskGitLabDetailResult = z.infer<typeof MobileWebTaskGitLabDetailResultSchema>
export type MobileWebTaskLinearDetailPayload = z.infer<
  typeof MobileWebTaskLinearDetailPayloadSchema
>
export type MobileWebTaskLinearDetailResult = z.infer<typeof MobileWebTaskLinearDetailResultSchema>
