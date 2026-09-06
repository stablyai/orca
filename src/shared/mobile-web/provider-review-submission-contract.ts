import { z } from 'zod'
import {
  MobileWebRelativePathSchema,
  MobileWebWorkspaceIdSchema
} from './bridge-operation-contract'
import {
  MOBILE_WEB_PROVIDER_COMMENT_BODY_MAX_CHARACTERS,
  MobileWebProviderReviewHeadSchema,
  MobileWebProviderReviewProviderSchema
} from './provider-review-contract'
import { isMobileWebBase64UrlIdentifier } from './protocol-token-contract'
import { MobileWebGitRefNameSchema } from './source-control-history-contract'

export const MOBILE_WEB_PROVIDER_REVIEW_SUBMISSION_COMMENT_LIMIT = 32
export const MOBILE_WEB_PROVIDER_REVIEW_SUBMISSION_SUMMARY_MAX_CHARACTERS = 8 * 1024
export const MOBILE_WEB_PROVIDER_REVIEW_SUBMISSION_TOTAL_MAX_CHARACTERS = 64 * 1024

export const MobileWebProviderReviewSubmissionActionSchema = z.enum([
  'comment',
  'approve',
  'request-changes'
])

export const MobileWebProviderReviewQueuedCommentSchema = z
  .object({
    id: z.string().refine((value) => isMobileWebBase64UrlIdentifier(value, 16, 64)),
    path: MobileWebRelativePathSchema,
    line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    body: z.string().trim().min(1).max(MOBILE_WEB_PROVIDER_COMMENT_BODY_MAX_CHARACTERS)
  })
  .strict()
  .superRefine((comment, context) => {
    if (comment.startLine !== undefined && comment.startLine > comment.line) {
      context.addIssue({ code: 'custom', message: 'Invalid comment line range' })
    }
  })

export const MobileWebProviderReviewSubmissionPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    expectedHead: MobileWebProviderReviewHeadSchema,
    expectedBranch: MobileWebGitRefNameSchema,
    provider: MobileWebProviderReviewProviderSchema,
    reviewNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedReviewHead: MobileWebProviderReviewHeadSchema,
    submissionId: z.string().refine((value) => isMobileWebBase64UrlIdentifier(value, 16, 64)),
    action: MobileWebProviderReviewSubmissionActionSchema,
    summary: z.string().trim().max(MOBILE_WEB_PROVIDER_REVIEW_SUBMISSION_SUMMARY_MAX_CHARACTERS),
    comments: z
      .array(MobileWebProviderReviewQueuedCommentSchema)
      .max(MOBILE_WEB_PROVIDER_REVIEW_SUBMISSION_COMMENT_LIMIT)
  })
  .strict()
  .superRefine((submission, context) => {
    if (
      new Set(submission.comments.map((comment) => comment.id)).size !== submission.comments.length
    ) {
      context.addIssue({ code: 'custom', message: 'Duplicate queued comment id' })
    }
    const retainedCharacters =
      submission.summary.length +
      submission.comments.reduce((total, comment) => total + comment.body.length, 0)
    if (retainedCharacters > MOBILE_WEB_PROVIDER_REVIEW_SUBMISSION_TOTAL_MAX_CHARACTERS) {
      context.addIssue({ code: 'custom', message: 'Review submission is too large' })
    }
    if (
      submission.action === 'comment' &&
      submission.summary.length === 0 &&
      submission.comments.length === 0
    ) {
      context.addIssue({ code: 'custom', message: 'Review submission is empty' })
    }
    if (submission.action === 'request-changes' && submission.summary.length === 0) {
      context.addIssue({ code: 'custom', message: 'Requested changes require a summary' })
    }
  })

export const MobileWebProviderReviewSubmissionResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    provider: MobileWebProviderReviewProviderSchema,
    reviewNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedReviewHead: MobileWebProviderReviewHeadSchema,
    submissionId: z.string().refine((value) => isMobileWebBase64UrlIdentifier(value, 16, 64)),
    action: MobileWebProviderReviewSubmissionActionSchema,
    submittedCommentIds: z
      .array(z.string().refine((value) => isMobileWebBase64UrlIdentifier(value, 16, 64)))
      .max(MOBILE_WEB_PROVIDER_REVIEW_SUBMISSION_COMMENT_LIMIT),
    outcome: z.literal('completed')
  })
  .strict()

export type MobileWebProviderReviewQueuedComment = z.infer<
  typeof MobileWebProviderReviewQueuedCommentSchema
>
export type MobileWebProviderReviewSubmissionPayload = z.infer<
  typeof MobileWebProviderReviewSubmissionPayloadSchema
>
export type MobileWebProviderReviewSubmissionResult = z.infer<
  typeof MobileWebProviderReviewSubmissionResultSchema
>
