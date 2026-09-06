import { z } from 'zod'
import { MobileWebTaskDetailCommentSchema } from './task-detail-contract'

const TargetIdSchema = z.string().min(1).max(128)
const BodySchema = z
  .string()
  .trim()
  .min(1)
  .max(64 * 1024)

export const MobileWebTaskItemCommentPayloadSchema = z
  .object({ targetId: TargetIdSchema, body: BodySchema })
  .strict()
export const MobileWebTaskItemCommentResultSchema = z
  .object({ comment: MobileWebTaskDetailCommentSchema.optional() })
  .strict()

export const MobileWebTaskItemReviewersPayloadSchema = z
  .object({
    targetId: TargetIdSchema,
    reviewers: z.array(z.string().min(1).max(240)).min(1).max(100)
  })
  .strict()

export const MobileWebTaskItemReviewThreadPayloadSchema = z
  .object({
    targetId: TargetIdSchema,
    threadId: z.string().min(1).max(512),
    resolve: z.boolean()
  })
  .strict()

export const MobileWebTaskItemReviewReplyPayloadSchema = z
  .object({
    targetId: TargetIdSchema,
    commentId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    body: BodySchema,
    threadId: z.string().min(1).max(512).optional(),
    path: z.string().min(1).max(4_096).optional(),
    line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

export const MobileWebTaskItemMergePayloadSchema = z
  .object({
    targetId: TargetIdSchema,
    method: z.enum(['merge', 'squash', 'rebase'])
  })
  .strict()

export const MobileWebTaskItemReviewMutationResultSchema = z.null()

export type MobileWebTaskItemCommentPayload = z.infer<typeof MobileWebTaskItemCommentPayloadSchema>
export type MobileWebTaskItemReviewersPayload = z.infer<
  typeof MobileWebTaskItemReviewersPayloadSchema
>
export type MobileWebTaskItemReviewThreadPayload = z.infer<
  typeof MobileWebTaskItemReviewThreadPayloadSchema
>
export type MobileWebTaskItemReviewReplyPayload = z.infer<
  typeof MobileWebTaskItemReviewReplyPayloadSchema
>
export type MobileWebTaskItemMergePayload = z.infer<typeof MobileWebTaskItemMergePayloadSchema>
