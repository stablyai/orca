import { z } from 'zod'
import {
  MobileWebRelativePathSchema,
  MobileWebWorkspaceIdSchema
} from './bridge-operation-contract'
import { isMobileWebGitObjectId } from './protocol-token-contract'
import { MobileWebGitRefNameSchema } from './source-control-history-contract'

export const MOBILE_WEB_PROVIDER_REVIEW_COMMENT_LIMIT = 32
export const MOBILE_WEB_PROVIDER_REVIEW_FILE_LIMIT = 48
export const MOBILE_WEB_PROVIDER_REVIEW_FILE_LINE_LIMIT = 256
export const MOBILE_WEB_PROVIDER_REVIEW_TOTAL_LINE_LIMIT = 2_048
export const MOBILE_WEB_PROVIDER_REVIEW_BODY_MAX_CHARACTERS = 32 * 1024
export const MOBILE_WEB_PROVIDER_REVIEW_COMMENT_MAX_CHARACTERS = 4 * 1024
export const MOBILE_WEB_PROVIDER_COMMENT_BODY_MAX_CHARACTERS = 8 * 1024
export const MOBILE_WEB_PROVIDER_REVIEW_CHECK_LIMIT = 128
export const MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT = 64

export const MobileWebProviderReviewProviderSchema = z.enum([
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
  'gitea'
])

export const MobileWebProviderReviewHeadSchema = z.string().refine(isMobileWebGitObjectId)

const MobileWebProviderReviewIdentityShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  expectedHead: MobileWebProviderReviewHeadSchema,
  expectedBranch: MobileWebGitRefNameSchema
} as const

export const MobileWebProviderReviewPayloadSchema = z
  .object(MobileWebProviderReviewIdentityShape)
  .strict()

export const MobileWebProviderReviewCommentSchema = z
  .object({
    id: z.string().min(1).max(128),
    author: z.string().max(160),
    body: z.string().max(MOBILE_WEB_PROVIDER_REVIEW_COMMENT_MAX_CHARACTERS),
    createdAt: z.string().max(64),
    kind: z.enum(['conversation', 'inline']),
    path: z.string().min(1).max(1024).optional(),
    line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    startLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    threadId: z.string().min(1).max(256).optional(),
    threadState: z.enum(['open', 'resolved', 'outdated']).optional(),
    allowedActions: z.array(z.enum(['reply', 'set-resolved'])).max(2),
    isBot: z.boolean().optional()
  })
  .strict()

export const MobileWebProviderReviewFileSchema = z
  .object({
    path: MobileWebRelativePathSchema,
    oldPath: MobileWebRelativePathSchema.optional(),
    status: z.enum(['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged']),
    additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    isBinary: z.boolean(),
    commentableLines: z
      .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .max(MOBILE_WEB_PROVIDER_REVIEW_FILE_LINE_LIMIT),
    commentableLinesTruncated: z.boolean()
  })
  .strict()

export const MobileWebProviderReviewUserSchema = z
  .object({
    login: z.string().min(1).max(80),
    name: z.string().max(160).nullable()
  })
  .strict()

export const MobileWebProviderReviewSummarySchema = z
  .object({
    login: z.string().min(1).max(80),
    state: z.string().max(80).nullable()
  })
  .strict()

export const MobileWebProviderReviewCheckSchema = z
  .object({
    name: z.string().min(1).max(256),
    status: z.enum(['queued', 'in_progress', 'completed']),
    conclusion: z
      .enum([
        'success',
        'failure',
        'cancelled',
        'timed_out',
        'neutral',
        'skipped',
        'pending',
        'action_required'
      ])
      .nullable(),
    checkRunId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    workflowRunId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

const MobileWebProviderMergeMethodSettingsSchema = z
  .object({
    defaultMethod: z.enum(['merge', 'squash', 'rebase']),
    allowedMethods: z
      .object({ merge: z.boolean(), squash: z.boolean(), rebase: z.boolean() })
      .strict()
  })
  .strict()

export const MobileWebProviderReviewSchema = z
  .object({
    provider: MobileWebProviderReviewProviderSchema,
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    title: z.string().max(512),
    state: z.enum(['open', 'closed', 'merged', 'draft']),
    checksStatus: z.enum(['success', 'failure', 'pending', 'neutral']),
    mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
    reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
    autoMergeEnabled: z.boolean().optional(),
    autoMergeAllowed: z.boolean().nullable().optional(),
    mergeStateStatus: z.string().max(80).nullable().optional(),
    mergeMethodSettings: MobileWebProviderMergeMethodSettingsSchema.optional(),
    updatedAt: z.string().max(64),
    headSha: MobileWebProviderReviewHeadSchema.optional(),
    body: z.string().max(MOBILE_WEB_PROVIDER_REVIEW_BODY_MAX_CHARACTERS),
    comments: z
      .array(MobileWebProviderReviewCommentSchema)
      .max(MOBILE_WEB_PROVIDER_REVIEW_COMMENT_LIMIT),
    commentsTruncated: z.boolean(),
    files: z.array(MobileWebProviderReviewFileSchema).max(MOBILE_WEB_PROVIDER_REVIEW_FILE_LIMIT),
    filesTruncated: z.boolean(),
    author: z.string().max(80).nullable().default(null),
    reviewRequests: z
      .array(MobileWebProviderReviewUserSchema)
      .max(MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT)
      .default([]),
    latestReviews: z
      .array(MobileWebProviderReviewSummarySchema)
      .max(MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT)
      .default([]),
    checks: z
      .array(MobileWebProviderReviewCheckSchema)
      .max(MOBILE_WEB_PROVIDER_REVIEW_CHECK_LIMIT)
      .default([]),
    detailsState: z.enum(['loaded', 'unsupported', 'unavailable']),
    canComment: z.boolean(),
    allowedSubmissionActions: z
      .array(z.enum(['comment', 'approve', 'request-changes']))
      .max(3)
      .default([])
  })
  .strict()
  .superRefine((value, context) => {
    const commentIds = new Set<string>()
    for (const comment of value.comments) {
      if (commentIds.has(comment.id)) {
        context.addIssue({
          code: 'custom',
          path: ['comments'],
          message: 'Duplicate review comment id'
        })
      }
      commentIds.add(comment.id)
    }
    const fileKeys = new Set<string>()
    for (const file of value.files) {
      const key = `${file.oldPath ?? ''}\0${file.path}`
      if (fileKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['files'],
          message: 'Duplicate review file key'
        })
      }
      fileKeys.add(key)
    }
  })

export const MobileWebProviderReviewResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    observedHead: MobileWebProviderReviewHeadSchema,
    branch: MobileWebGitRefNameSchema,
    review: MobileWebProviderReviewSchema.nullable()
  })
  .strict()

const MobileWebProviderReviewMutationBaseShape = {
  ...MobileWebProviderReviewIdentityShape,
  provider: MobileWebProviderReviewProviderSchema,
  reviewNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
} as const

const MobileWebProviderReviewCommentMutationPayloadSchema = z
  .object({
    ...MobileWebProviderReviewMutationBaseShape,
    action: z.literal('comment'),
    body: z.string().trim().min(1).max(MOBILE_WEB_PROVIDER_COMMENT_BODY_MAX_CHARACTERS)
  })
  .strict()

const MobileWebProviderReviewReplyMutationPayloadSchema = z
  .object({
    ...MobileWebProviderReviewMutationBaseShape,
    action: z.literal('reply'),
    commentId: z.string().min(1).max(128),
    threadId: z.string().min(1).max(256),
    body: z.string().trim().min(1).max(MOBILE_WEB_PROVIDER_COMMENT_BODY_MAX_CHARACTERS)
  })
  .strict()

const MobileWebProviderReviewInlineCommentMutationPayloadSchema = z
  .object({
    ...MobileWebProviderReviewMutationBaseShape,
    action: z.literal('inlineComment'),
    expectedReviewHead: MobileWebProviderReviewHeadSchema,
    path: MobileWebRelativePathSchema,
    line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    body: z.string().trim().min(1).max(MOBILE_WEB_PROVIDER_COMMENT_BODY_MAX_CHARACTERS)
  })
  .strict()

const MobileWebProviderReviewThreadMutationPayloadSchema = z
  .object({
    ...MobileWebProviderReviewMutationBaseShape,
    action: z.literal('setThreadResolved'),
    threadId: z.string().min(1).max(256),
    resolved: z.boolean()
  })
  .strict()

export const MobileWebProviderReviewMutationPayloadSchema = z.discriminatedUnion('action', [
  MobileWebProviderReviewCommentMutationPayloadSchema,
  MobileWebProviderReviewReplyMutationPayloadSchema,
  MobileWebProviderReviewInlineCommentMutationPayloadSchema,
  MobileWebProviderReviewThreadMutationPayloadSchema
])

const MobileWebProviderReviewMutationResultBaseShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  provider: MobileWebProviderReviewProviderSchema,
  reviewNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  outcome: z.literal('completed')
} as const

const MobileWebProviderReviewCommentMutationResultSchema = z
  .object({
    ...MobileWebProviderReviewMutationResultBaseShape,
    action: z.literal('comment')
  })
  .strict()

const MobileWebProviderReviewReplyMutationResultSchema = z
  .object({
    ...MobileWebProviderReviewMutationResultBaseShape,
    action: z.literal('reply'),
    commentId: z.string().min(1).max(128),
    threadId: z.string().min(1).max(256)
  })
  .strict()

const MobileWebProviderReviewInlineCommentMutationResultSchema = z
  .object({
    ...MobileWebProviderReviewMutationResultBaseShape,
    action: z.literal('inlineComment'),
    expectedReviewHead: MobileWebProviderReviewHeadSchema,
    path: MobileWebRelativePathSchema,
    line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

const MobileWebProviderReviewThreadMutationResultSchema = z
  .object({
    ...MobileWebProviderReviewMutationResultBaseShape,
    action: z.literal('setThreadResolved'),
    threadId: z.string().min(1).max(256),
    resolved: z.boolean()
  })
  .strict()

export const MobileWebProviderReviewMutationResultSchema = z.discriminatedUnion('action', [
  MobileWebProviderReviewCommentMutationResultSchema,
  MobileWebProviderReviewReplyMutationResultSchema,
  MobileWebProviderReviewInlineCommentMutationResultSchema,
  MobileWebProviderReviewThreadMutationResultSchema
])

export type MobileWebProviderReviewProvider = z.infer<typeof MobileWebProviderReviewProviderSchema>
export type MobileWebProviderReviewPayload = z.infer<typeof MobileWebProviderReviewPayloadSchema>
export type MobileWebProviderReviewComment = z.infer<typeof MobileWebProviderReviewCommentSchema>
export type MobileWebProviderReviewFile = z.infer<typeof MobileWebProviderReviewFileSchema>
export type MobileWebProviderReview = z.infer<typeof MobileWebProviderReviewSchema>
export type MobileWebProviderReviewResult = z.infer<typeof MobileWebProviderReviewResultSchema>
export type MobileWebProviderReviewMutationPayload = z.infer<
  typeof MobileWebProviderReviewMutationPayloadSchema
>
export type MobileWebProviderReviewMutationResult = z.infer<
  typeof MobileWebProviderReviewMutationResultSchema
>
