import { z } from 'zod'
import {
  MobileWebTaskDetailCommentSchema,
  MobileWebTaskGitHubDetailCheckSchema
} from './task-detail-contract'

const TargetIdSchema = z.string().min(1).max(128)
const PathSchema = z.string().min(1).max(4_096)
const BodySchema = z
  .string()
  .trim()
  .min(1)
  .max(64 * 1024)

export const MobileWebTaskItemChecksPayloadSchema = z.object({ targetId: TargetIdSchema }).strict()
export const MobileWebTaskItemChecksResultSchema = z
  .object({ checks: z.array(MobileWebTaskGitHubDetailCheckSchema).max(1_000) })
  .strict()

export const MobileWebTaskItemRerunChecksPayloadSchema = z
  .object({ targetId: TargetIdSchema, failedOnly: z.boolean() })
  .strict()

export const MobileWebTaskItemFileViewedPayloadSchema = z
  .object({ targetId: TargetIdSchema, path: PathSchema, viewed: z.boolean() })
  .strict()

export const MobileWebTaskItemFileContentsPayloadSchema = z
  .object({ targetId: TargetIdSchema, path: PathSchema })
  .strict()
export const MobileWebTaskItemFileContentsResultSchema = z
  .object({
    original: z.string().max(256 * 1024),
    modified: z.string().max(256 * 1024),
    originalIsBinary: z.boolean(),
    modifiedIsBinary: z.boolean(),
    originalTooLarge: z.boolean().optional(),
    modifiedTooLarge: z.boolean().optional()
  })
  .strict()

export const MobileWebTaskItemInlineCommentPayloadSchema = z
  .object({
    targetId: TargetIdSchema,
    path: PathSchema,
    line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    body: BodySchema
  })
  .strict()
export const MobileWebTaskItemInlineCommentResultSchema = z
  .object({ comment: MobileWebTaskDetailCommentSchema.optional() })
  .strict()

export const MobileWebTaskItemFileMutationResultSchema = z.null()

export type MobileWebTaskItemChecksPayload = z.infer<typeof MobileWebTaskItemChecksPayloadSchema>
export type MobileWebTaskItemRerunChecksPayload = z.infer<
  typeof MobileWebTaskItemRerunChecksPayloadSchema
>
export type MobileWebTaskItemFileViewedPayload = z.infer<
  typeof MobileWebTaskItemFileViewedPayloadSchema
>
export type MobileWebTaskItemFileContentsPayload = z.infer<
  typeof MobileWebTaskItemFileContentsPayloadSchema
>
export type MobileWebTaskItemInlineCommentPayload = z.infer<
  typeof MobileWebTaskItemInlineCommentPayloadSchema
>
