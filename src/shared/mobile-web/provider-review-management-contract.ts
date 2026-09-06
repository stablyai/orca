import { z } from 'zod'
import { isMobileWebGitObjectId } from './protocol-token-contract'
import { MobileWebGitRefNameSchema } from './source-control-history-contract'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

const ProviderSchema = z.enum(['github', 'gitlab', 'bitbucket', 'azure-devops', 'gitea'])
const HeadSchema = z.string().refine(isMobileWebGitObjectId)
const ReviewNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const ReviewersSchema = z.array(z.string().trim().min(1).max(80)).min(1).max(32)
const CommentIdSchema = z.string().min(1).max(128)
const MergeMethodSchema = z.enum(['merge', 'squash', 'rebase'])

const ManagementIdentityShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  expectedHead: HeadSchema,
  expectedBranch: MobileWebGitRefNameSchema,
  provider: ProviderSchema,
  reviewNumber: ReviewNumberSchema
} as const

export const MobileWebProviderReviewManagementPayloadSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...ManagementIdentityShape,
      action: z.literal('merge'),
      method: MergeMethodSchema.optional()
    })
    .strict(),
  z
    .object({
      ...ManagementIdentityShape,
      action: z.literal('setAutoMerge'),
      enabled: z.boolean(),
      method: MergeMethodSchema.optional()
    })
    .strict(),
  z
    .object({
      ...ManagementIdentityShape,
      action: z.literal('setState'),
      state: z.enum(['open', 'closed'])
    })
    .strict(),
  z
    .object({
      ...ManagementIdentityShape,
      action: z.literal('requestReviewers'),
      reviewers: ReviewersSchema
    })
    .strict(),
  z
    .object({
      ...ManagementIdentityShape,
      action: z.literal('removeReviewers'),
      reviewers: ReviewersSchema
    })
    .strict(),
  z
    .object({
      ...ManagementIdentityShape,
      action: z.literal('rerunChecks'),
      expectedReviewHead: HeadSchema.optional(),
      failedOnly: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      ...ManagementIdentityShape,
      action: z.literal('updateTitle'),
      title: z.string().trim().min(1).max(512)
    })
    .strict(),
  z
    .object({
      ...ManagementIdentityShape,
      action: z.literal('updateConversationComment'),
      commentId: CommentIdSchema,
      body: z
        .string()
        .trim()
        .min(1)
        .max(8 * 1024)
    })
    .strict(),
  z
    .object({
      ...ManagementIdentityShape,
      action: z.literal('deleteConversationComment'),
      commentId: CommentIdSchema
    })
    .strict()
])

export const MobileWebProviderReviewManagementResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    provider: ProviderSchema,
    reviewNumber: ReviewNumberSchema,
    action: z.enum([
      'merge',
      'setAutoMerge',
      'setState',
      'requestReviewers',
      'removeReviewers',
      'rerunChecks',
      'updateTitle',
      'updateConversationComment',
      'deleteConversationComment'
    ]),
    outcome: z.literal('completed')
  })
  .strict()

export type MobileWebProviderReviewManagementPayload = z.infer<
  typeof MobileWebProviderReviewManagementPayloadSchema
>
export type MobileWebProviderReviewManagementResult = z.infer<
  typeof MobileWebProviderReviewManagementResultSchema
>
