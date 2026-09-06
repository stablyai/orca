import { z } from 'zod'
import {
  MobileWebRelativePathSchema,
  MobileWebWorkspaceIdSchema
} from './bridge-operation-contract'
import {
  MobileWebProviderReviewHeadSchema,
  MobileWebProviderReviewProviderSchema
} from './provider-review-contract'
import { isMobileWebSha256 } from './protocol-token-contract'
import { MobileWebGitRefNameSchema } from './source-control-history-contract'
import {
  MOBILE_WEB_DIFF_MAX_ROWS,
  MOBILE_WEB_DIFF_PAGE_LIMIT,
  MobileWebDiffRowSchema
} from './source-control-operation-contract'

const MobileWebProviderReviewDiffIdentityShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  provider: MobileWebProviderReviewProviderSchema,
  reviewNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reviewHead: MobileWebProviderReviewHeadSchema,
  path: MobileWebRelativePathSchema
} as const

export const MobileWebProviderReviewDiffPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    expectedHead: MobileWebProviderReviewHeadSchema,
    expectedBranch: MobileWebGitRefNameSchema,
    provider: MobileWebProviderReviewProviderSchema,
    reviewNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedReviewHead: MobileWebProviderReviewHeadSchema,
    path: MobileWebRelativePathSchema,
    offset: z.number().int().min(0).max(MOBILE_WEB_DIFF_MAX_ROWS).default(0),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MOBILE_WEB_DIFF_PAGE_LIMIT)
      .default(MOBILE_WEB_DIFF_PAGE_LIMIT),
    expectedRevision: z.string().refine(isMobileWebSha256).optional(),
    focusLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.focusLine !== undefined && (value.offset !== 0 || value.expectedRevision)) {
      context.addIssue({
        code: 'custom',
        message: 'focusLine is only valid for an initial page'
      })
    }
  })

const MobileWebProviderReviewDiffResultIdentityShape = {
  ...MobileWebProviderReviewDiffIdentityShape,
  observedHead: MobileWebProviderReviewHeadSchema,
  branch: MobileWebGitRefNameSchema
} as const

const MobileWebProviderReviewTextDiffResultSchema = z
  .object({
    ...MobileWebProviderReviewDiffResultIdentityShape,
    kind: z.literal('text'),
    revision: z.string().refine(isMobileWebSha256),
    offset: z.number().int().min(0).max(MOBILE_WEB_DIFF_MAX_ROWS),
    totalRows: z.number().int().min(0).max(MOBILE_WEB_DIFF_MAX_ROWS),
    rows: z.array(MobileWebDiffRowSchema).max(MOBILE_WEB_DIFF_PAGE_LIMIT),
    nextOffset: z.number().int().min(1).max(MOBILE_WEB_DIFF_MAX_ROWS).nullable(),
    truncated: z.boolean(),
    focusLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    focusRowIndex: z
      .number()
      .int()
      .min(0)
      .max(MOBILE_WEB_DIFF_MAX_ROWS - 1)
      .optional()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.focusLine === undefined) !== (value.focusRowIndex === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'focusLine and focusRowIndex must be returned together'
      })
    }
    if (
      value.focusRowIndex !== undefined &&
      !value.rows.some(
        (row) => row.index === value.focusRowIndex && row.newLineNumber === value.focusLine
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'focused row must be present in the returned page'
      })
    }
  })

const MobileWebProviderReviewBinaryDiffResultSchema = z
  .object({
    ...MobileWebProviderReviewDiffResultIdentityShape,
    kind: z.literal('binary')
  })
  .strict()

const MobileWebProviderReviewLargeDiffResultSchema = z
  .object({
    ...MobileWebProviderReviewDiffResultIdentityShape,
    kind: z.literal('too-large'),
    reason: z.enum(['host-limit', 'mobile-limit']),
    characterCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

export const MobileWebProviderReviewDiffResultSchema = z.discriminatedUnion('kind', [
  MobileWebProviderReviewTextDiffResultSchema,
  MobileWebProviderReviewBinaryDiffResultSchema,
  MobileWebProviderReviewLargeDiffResultSchema
])

export type MobileWebProviderReviewDiffPayload = z.infer<
  typeof MobileWebProviderReviewDiffPayloadSchema
>
export type MobileWebProviderReviewDiffResult = z.infer<
  typeof MobileWebProviderReviewDiffResultSchema
>
