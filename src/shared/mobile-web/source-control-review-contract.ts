import { z } from 'zod'
import {
  MOBILE_WEB_DIFF_MAX_ROWS,
  MOBILE_WEB_DIFF_PAGE_LIMIT,
  MobileWebDiffRowSchema
} from './source-control-operation-contract'
import { MobileWebRelativePathSchema } from './file-operation-contract'
import { isMobileWebGitObjectId, isMobileWebSha256 } from './protocol-token-contract'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

export const MOBILE_WEB_REVIEW_COMMENT_LIMIT = 64
export const MOBILE_WEB_REVIEW_FILE_STATE_LIMIT = 128
export const MOBILE_WEB_REVIEW_COMMENT_MAX_CHARACTERS = 8_192
export const MOBILE_WEB_REVIEW_TERMINAL_TEXT_MAX_CHARACTERS = 96 * 1_024

const RevisionSchema = z.string().refine(isMobileWebSha256)
const ObjectIdSchema = z.string().refine(isMobileWebGitObjectId)
const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const ReviewScopeSchema = z.enum(['unstaged', 'staged', 'branch'])
const DiffIdentitySchema = z.string().min(1).max(512)

export const MobileWebSourceControlReviewCommentSchema = z
  .object({
    id: z.string().min(1).max(512),
    relativePath: MobileWebRelativePathSchema,
    oldRelativePath: MobileWebRelativePathSchema.optional(),
    source: z.enum(['diff', 'markdown']).optional(),
    selectedText: z.string().max(MOBILE_WEB_REVIEW_COMMENT_MAX_CHARACTERS).optional(),
    startLine: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    lineNumber: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    body: z.string().min(1).max(MOBILE_WEB_REVIEW_COMMENT_MAX_CHARACTERS),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema.optional(),
    sentAt: TimestampSchema.optional(),
    scope: ReviewScopeSchema.optional(),
    diffIdentity: DiffIdentitySchema.optional(),
    side: z.literal('modified')
  })
  .strict()

export const MobileWebSourceControlReviewFileStateSchema = z
  .object({
    key: z.string().min(1).max(512),
    relativePath: MobileWebRelativePathSchema,
    oldRelativePath: MobileWebRelativePathSchema.optional(),
    scope: ReviewScopeSchema,
    lastOpenedAt: TimestampSchema.optional(),
    lastSeenDiffIdentity: DiffIdentitySchema.optional(),
    reviewedAt: TimestampSchema.optional(),
    reviewDiffIdentity: DiffIdentitySchema.optional()
  })
  .strict()

export const MobileWebSourceControlReviewStateSchema = z
  .object({
    version: z.literal(1),
    updatedAt: TimestampSchema.optional(),
    completedAt: TimestampSchema.optional(),
    files: z
      .array(MobileWebSourceControlReviewFileStateSchema)
      .max(MOBILE_WEB_REVIEW_FILE_STATE_LIMIT)
  })
  .strict()

export const MobileWebSourceControlReviewMetadataPayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()

const HostedReviewProviderSchema = z.enum([
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
  'gitea'
])

export const MobileWebSourceControlReviewLinkPayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()

export const MobileWebSourceControlReviewLinkResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    baseRef: z.string().min(1).max(512).nullable(),
    linkedGitHubPR: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    linkedGitLabMR: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    linkedBitbucketPR: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    linkedAzureDevOpsPR: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    linkedGiteaPR: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable()
  })
  .strict()

export const MobileWebSourceControlReviewLinkUpdatePayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    provider: HostedReviewProviderSchema,
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    baseRef: z.string().trim().min(1).max(512).optional()
  })
  .strict()

const ReviewMetadataShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  revision: RevisionSchema,
  comments: z.array(MobileWebSourceControlReviewCommentSchema).max(MOBILE_WEB_REVIEW_COMMENT_LIMIT),
  reviewState: MobileWebSourceControlReviewStateSchema
} as const

export const MobileWebSourceControlReviewMetadataResultSchema = z
  .object(ReviewMetadataShape)
  .strict()
  .superRefine(rejectDuplicateReviewMetadataKeys)

export const MobileWebSourceControlReviewMetadataUpdatePayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    expectedRevision: RevisionSchema,
    comments: ReviewMetadataShape.comments,
    reviewState: ReviewMetadataShape.reviewState
  })
  .strict()
  .superRefine(rejectDuplicateReviewMetadataKeys)

export const MobileWebSourceControlReviewCompareSchema = z
  .object({
    baseRef: z.string().min(1).max(512),
    baseOid: ObjectIdSchema.optional(),
    headOid: ObjectIdSchema,
    mergeBase: ObjectIdSchema
  })
  .strict()

export const MobileWebSourceControlReviewDiffPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    relativePath: MobileWebRelativePathSchema,
    oldRelativePath: MobileWebRelativePathSchema.optional(),
    scope: ReviewScopeSchema,
    compare: MobileWebSourceControlReviewCompareSchema.optional(),
    offset: z.number().int().min(0).max(MOBILE_WEB_DIFF_MAX_ROWS).default(0),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MOBILE_WEB_DIFF_PAGE_LIMIT)
      .default(MOBILE_WEB_DIFF_PAGE_LIMIT),
    expectedRevision: RevisionSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.scope === 'branch') !== Boolean(value.compare)) {
      context.addIssue({
        code: 'custom',
        path: ['compare'],
        message: 'Branch diffs require exact compare identity'
      })
    }
  })

const ReviewDiffIdentityShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  relativePath: MobileWebRelativePathSchema,
  scope: ReviewScopeSchema
} as const

export const MobileWebSourceControlReviewDiffResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...ReviewDiffIdentityShape,
      kind: z.literal('text'),
      revision: RevisionSchema,
      offset: z.number().int().min(0).max(MOBILE_WEB_DIFF_MAX_ROWS),
      totalRows: z.number().int().min(0).max(MOBILE_WEB_DIFF_MAX_ROWS),
      rows: z.array(MobileWebDiffRowSchema).max(MOBILE_WEB_DIFF_PAGE_LIMIT),
      nextOffset: z.number().int().min(1).max(MOBILE_WEB_DIFF_MAX_ROWS).nullable(),
      truncated: z.boolean()
    })
    .strict(),
  z.object({ ...ReviewDiffIdentityShape, kind: z.literal('binary') }).strict(),
  z
    .object({
      ...ReviewDiffIdentityShape,
      kind: z.literal('too-large'),
      reason: z.enum(['host-limit', 'mobile-limit']),
      characterCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
    })
    .strict()
])

export const MobileWebSourceControlReviewOpenPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    relativePath: MobileWebRelativePathSchema,
    scope: z.enum(['unstaged', 'staged'])
  })
  .strict()
export const MobileWebSourceControlReviewOpenResultSchema = z.null()

export const MobileWebSourceControlReviewTerminalSendPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    tabId: z.string().min(1).max(512),
    text: z.string().min(1).max(MOBILE_WEB_REVIEW_TERMINAL_TEXT_MAX_CHARACTERS),
    enter: z.literal(true)
  })
  .strict()
export const MobileWebSourceControlReviewTerminalSendResultSchema = z
  .object({ accepted: z.boolean() })
  .strict()

export type MobileWebSourceControlReviewComment = z.infer<
  typeof MobileWebSourceControlReviewCommentSchema
>
export type MobileWebSourceControlReviewState = z.infer<
  typeof MobileWebSourceControlReviewStateSchema
>
export type MobileWebSourceControlReviewMetadataPayload = z.infer<
  typeof MobileWebSourceControlReviewMetadataPayloadSchema
>
export type MobileWebSourceControlReviewLinkPayload = z.infer<
  typeof MobileWebSourceControlReviewLinkPayloadSchema
>
export type MobileWebSourceControlReviewLinkResult = z.infer<
  typeof MobileWebSourceControlReviewLinkResultSchema
>
export type MobileWebSourceControlReviewLinkUpdatePayload = z.infer<
  typeof MobileWebSourceControlReviewLinkUpdatePayloadSchema
>
export type MobileWebSourceControlReviewMetadataResult = z.infer<
  typeof MobileWebSourceControlReviewMetadataResultSchema
>
export type MobileWebSourceControlReviewMetadataUpdatePayload = z.infer<
  typeof MobileWebSourceControlReviewMetadataUpdatePayloadSchema
>
export type MobileWebSourceControlReviewDiffPayload = z.infer<
  typeof MobileWebSourceControlReviewDiffPayloadSchema
>
export type MobileWebSourceControlReviewDiffResult = z.infer<
  typeof MobileWebSourceControlReviewDiffResultSchema
>
export type MobileWebSourceControlReviewOpenPayload = z.infer<
  typeof MobileWebSourceControlReviewOpenPayloadSchema
>
export type MobileWebSourceControlReviewTerminalSendPayload = z.infer<
  typeof MobileWebSourceControlReviewTerminalSendPayloadSchema
>
export type MobileWebSourceControlReviewTerminalSendResult = z.infer<
  typeof MobileWebSourceControlReviewTerminalSendResultSchema
>

function rejectDuplicateReviewMetadataKeys(
  value: {
    comments: { id: string }[]
    reviewState: { files: { key: string }[] }
  },
  context: z.RefinementCtx
): void {
  rejectDuplicateKeys(
    value.comments.map((comment) => comment.id),
    'comments',
    'Duplicate review comment id',
    context
  )
  rejectDuplicateKeys(
    value.reviewState.files.map((file) => file.key),
    'reviewState',
    'Duplicate review file key',
    context
  )
}

function rejectDuplicateKeys(
  keys: string[],
  path: string,
  message: string,
  context: z.RefinementCtx
): void {
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) {
      context.addIssue({ code: 'custom', path: [path], message })
    }
    seen.add(key)
  }
}
