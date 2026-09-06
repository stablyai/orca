import { z } from 'zod'
import {
  MobileWebTaskDetailCommentSchema,
  MobileWebTaskGitHubDetailCheckSchema
} from './task-detail-contract'
import { MobileWebTaskProjectFieldMutationValueSchema } from './task-project-table-contract'

const TargetIdSchema = z.string().min(1).max(128)
const RepoIdSchema = z.string().min(1).max(128)
const BodySchema = z
  .string()
  .min(1)
  .max(64 * 1024)
const NameSchema = z.string().min(1).max(240)

export const MobileWebTaskProjectItemUpdatePayloadSchema = z
  .object({
    targetId: TargetIdSchema,
    updates: z
      .object({
        title: z.string().min(1).max(2_000).optional(),
        body: z
          .string()
          .max(64 * 1024)
          .optional(),
        state: z.enum(['open', 'closed']).optional()
      })
      .strict()
      .refine((updates) => Object.keys(updates).length > 0)
  })
  .strict()

export const MobileWebTaskProjectCommentAddPayloadSchema = z
  .object({ targetId: TargetIdSchema, body: BodySchema })
  .strict()
export const MobileWebTaskProjectCommentUpdatePayloadSchema = z
  .object({
    targetId: TargetIdSchema,
    commentId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    body: BodySchema
  })
  .strict()
export const MobileWebTaskProjectCommentDeletePayloadSchema = z
  .object({
    targetId: TargetIdSchema,
    commentId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

export const MobileWebTaskProjectMetadataUpdatePayloadSchema = z
  .object({
    targetId: TargetIdSchema,
    updates: z
      .object({
        addLabels: z.array(NameSchema).max(100).optional(),
        removeLabels: z.array(NameSchema).max(100).optional(),
        addAssignees: z.array(NameSchema).max(100).optional(),
        removeAssignees: z.array(NameSchema).max(100).optional()
      })
      .strict()
      .refine((updates) => Object.values(updates).some((values) => values?.length))
  })
  .strict()

export const MobileWebTaskProjectFieldUpdatePayloadSchema = z
  .object({
    targetId: TargetIdSchema,
    fieldId: z.string().min(1).max(240),
    value: MobileWebTaskProjectFieldMutationValueSchema.nullable()
  })
  .strict()

export const MobileWebTaskProjectIssueTypeUpdatePayloadSchema = z
  .object({
    targetId: TargetIdSchema,
    issueTypeId: z.string().min(1).max(240).nullable()
  })
  .strict()

const ProjectReviewTargetSchema = z
  .object({ targetId: TargetIdSchema, repoId: RepoIdSchema })
  .strict()
export const MobileWebTaskProjectReviewThreadPayloadSchema = ProjectReviewTargetSchema.extend({
  threadId: z.string().min(1).max(512),
  resolve: z.boolean()
}).strict()
export const MobileWebTaskProjectReviewReplyPayloadSchema = ProjectReviewTargetSchema.extend({
  commentId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  body: BodySchema,
  threadId: z.string().min(1).max(512).optional(),
  path: z.string().min(1).max(4_096).optional(),
  line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
}).strict()
export const MobileWebTaskProjectConversationCommentPayloadSchema =
  ProjectReviewTargetSchema.extend({ body: BodySchema }).strict()
export const MobileWebTaskProjectReviewersPayloadSchema = ProjectReviewTargetSchema.extend({
  reviewers: z.array(NameSchema).min(1).max(100)
}).strict()
export const MobileWebTaskProjectRerunChecksPayloadSchema = ProjectReviewTargetSchema.extend({
  headSha: z.string().min(1).max(160).optional(),
  failedOnly: z.boolean()
}).strict()
export const MobileWebTaskProjectMergePayloadSchema = ProjectReviewTargetSchema.extend({
  method: z.enum(['merge', 'squash', 'rebase'])
}).strict()
export const MobileWebTaskProjectChecksPayloadSchema = ProjectReviewTargetSchema.extend({
  headSha: z.string().min(1).max(160).optional()
}).strict()
export const MobileWebTaskProjectChecksResultSchema = z
  .object({ checks: z.array(MobileWebTaskGitHubDetailCheckSchema).max(1_000) })
  .strict()
export const MobileWebTaskProjectFileViewedPayloadSchema = ProjectReviewTargetSchema.extend({
  pullRequestId: z.string().min(1).max(240),
  path: z.string().min(1).max(4_096),
  viewed: z.boolean()
}).strict()
export const MobileWebTaskProjectFileContentsPayloadSchema = ProjectReviewTargetSchema.extend({
  path: z.string().min(1).max(4_096),
  oldPath: z.string().min(1).max(4_096).optional(),
  status: z.enum(['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged']),
  headSha: z.string().min(1).max(160),
  baseSha: z.string().min(1).max(160)
}).strict()
export const MobileWebTaskProjectFileContentsResultSchema = z
  .object({
    original: z.string().max(256 * 1024),
    modified: z.string().max(256 * 1024),
    originalIsBinary: z.boolean(),
    modifiedIsBinary: z.boolean(),
    originalTooLarge: z.boolean().optional(),
    modifiedTooLarge: z.boolean().optional()
  })
  .strict()
export const MobileWebTaskProjectInlineCommentPayloadSchema = ProjectReviewTargetSchema.extend({
  commitId: z.string().min(1).max(160),
  path: z.string().min(1).max(4_096),
  line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  body: BodySchema
}).strict()

export const MobileWebTaskProjectMutationResultSchema = z.null()
export const MobileWebTaskProjectCommentAddResultSchema = z
  .object({ comment: MobileWebTaskDetailCommentSchema.optional() })
  .strict()

export type MobileWebTaskProjectItemUpdatePayload = z.infer<
  typeof MobileWebTaskProjectItemUpdatePayloadSchema
>
export type MobileWebTaskProjectCommentAddPayload = z.infer<
  typeof MobileWebTaskProjectCommentAddPayloadSchema
>
export type MobileWebTaskProjectCommentUpdatePayload = z.infer<
  typeof MobileWebTaskProjectCommentUpdatePayloadSchema
>
export type MobileWebTaskProjectCommentDeletePayload = z.infer<
  typeof MobileWebTaskProjectCommentDeletePayloadSchema
>
export type MobileWebTaskProjectMetadataUpdatePayload = z.infer<
  typeof MobileWebTaskProjectMetadataUpdatePayloadSchema
>
export type MobileWebTaskProjectFieldUpdatePayload = z.infer<
  typeof MobileWebTaskProjectFieldUpdatePayloadSchema
>
export type MobileWebTaskProjectIssueTypeUpdatePayload = z.infer<
  typeof MobileWebTaskProjectIssueTypeUpdatePayloadSchema
>
export type MobileWebTaskProjectReviewThreadPayload = z.infer<
  typeof MobileWebTaskProjectReviewThreadPayloadSchema
>
export type MobileWebTaskProjectReviewReplyPayload = z.infer<
  typeof MobileWebTaskProjectReviewReplyPayloadSchema
>
export type MobileWebTaskProjectConversationCommentPayload = z.infer<
  typeof MobileWebTaskProjectConversationCommentPayloadSchema
>
export type MobileWebTaskProjectReviewersPayload = z.infer<
  typeof MobileWebTaskProjectReviewersPayloadSchema
>
export type MobileWebTaskProjectRerunChecksPayload = z.infer<
  typeof MobileWebTaskProjectRerunChecksPayloadSchema
>
export type MobileWebTaskProjectMergePayload = z.infer<
  typeof MobileWebTaskProjectMergePayloadSchema
>
export type MobileWebTaskProjectChecksPayload = z.infer<
  typeof MobileWebTaskProjectChecksPayloadSchema
>
export type MobileWebTaskProjectFileViewedPayload = z.infer<
  typeof MobileWebTaskProjectFileViewedPayloadSchema
>
export type MobileWebTaskProjectFileContentsPayload = z.infer<
  typeof MobileWebTaskProjectFileContentsPayloadSchema
>
export type MobileWebTaskProjectInlineCommentPayload = z.infer<
  typeof MobileWebTaskProjectInlineCommentPayloadSchema
>
