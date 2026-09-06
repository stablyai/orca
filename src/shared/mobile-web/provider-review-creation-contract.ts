import { z } from 'zod'
import { isMobileWebGitObjectId } from './protocol-token-contract'
import { MobileWebGitRefNameSchema } from './source-control-history-contract'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

const ProviderSchema = z.enum([
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
  'gitea',
  'unsupported'
])
const CreatableProviderSchema = ProviderSchema.exclude(['unsupported'])
const HeadSchema = z.string().refine(isMobileWebGitObjectId)
const ReviewNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const HttpsUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => value.startsWith('https://'))

const RepositoryIdentityShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  expectedHead: HeadSchema,
  expectedBranch: MobileWebGitRefNameSchema
} as const

export const MobileWebProviderReviewEligibilityPayloadSchema = z
  .object({
    ...RepositoryIdentityShape,
    base: MobileWebGitRefNameSchema.nullable().optional()
  })
  .strict()

const ReviewSummarySchema = z
  .object({ number: ReviewNumberSchema.optional(), url: HttpsUrlSchema })
  .strict()

export const MobileWebProviderReviewEligibilityResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    observedHead: HeadSchema,
    branch: MobileWebGitRefNameSchema,
    provider: ProviderSchema,
    review: ReviewSummarySchema.nullable(),
    canCreate: z.boolean(),
    blockedReason: z
      .enum([
        'dirty',
        'detached_head',
        'default_branch',
        'no_upstream',
        'needs_push',
        'needs_sync',
        'auth_required',
        'fork_head_unsupported',
        'unsupported_provider',
        'existing_review',
        'base_not_on_remote'
      ])
      .nullable(),
    nextAction: z
      .enum(['commit', 'publish', 'push', 'sync', 'authenticate', 'open_existing_review'])
      .nullable(),
    reviewLookupOutcome: z.enum(['found', 'not_found', 'unavailable']),
    defaultBaseRef: MobileWebGitRefNameSchema.nullable().optional(),
    head: MobileWebGitRefNameSchema.nullable().optional(),
    title: z.string().max(512).nullable().optional(),
    body: z
      .string()
      .max(32 * 1024)
      .nullable()
      .optional()
  })
  .strict()

export const MobileWebProviderReviewCreatePayloadSchema = z
  .object({
    ...RepositoryIdentityShape,
    provider: CreatableProviderSchema,
    base: MobileWebGitRefNameSchema,
    head: MobileWebGitRefNameSchema.optional(),
    title: z.string().trim().min(1).max(512),
    body: z.string().max(32 * 1024),
    draft: z.boolean(),
    useTemplate: z.boolean().optional()
  })
  .strict()

export const MobileWebProviderReviewCreateResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      workspaceId: MobileWebWorkspaceIdSchema,
      provider: CreatableProviderSchema,
      ok: z.literal(true),
      number: ReviewNumberSchema,
      url: HttpsUrlSchema
    })
    .strict(),
  z
    .object({
      workspaceId: MobileWebWorkspaceIdSchema,
      provider: CreatableProviderSchema,
      ok: z.literal(false),
      code: z.enum([
        'auth_required',
        'unsupported_provider',
        'already_exists',
        'validation',
        'timeout',
        'unknown_completion',
        'push_failed',
        'unknown'
      ]),
      error: z.string().max(1024),
      existingReview: ReviewSummarySchema.optional()
    })
    .strict()
])

export const MobileWebProviderReviewFieldsPayloadSchema = z
  .object({
    ...RepositoryIdentityShape,
    base: MobileWebGitRefNameSchema,
    title: z.string().max(512),
    body: z.string().max(32 * 1024),
    draft: z.boolean()
  })
  .strict()

export const MobileWebProviderReviewFieldsResultSchema = z.discriminatedUnion('success', [
  z
    .object({
      workspaceId: MobileWebWorkspaceIdSchema,
      success: z.literal(true),
      fields: z
        .object({
          base: MobileWebGitRefNameSchema,
          title: z.string().max(512),
          body: z.string().max(32 * 1024),
          draft: z.boolean()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      workspaceId: MobileWebWorkspaceIdSchema,
      success: z.literal(false),
      error: z.string().max(1024)
    })
    .strict()
])

export type MobileWebProviderReviewEligibilityPayload = z.infer<
  typeof MobileWebProviderReviewEligibilityPayloadSchema
>
export type MobileWebProviderReviewEligibilityResult = z.infer<
  typeof MobileWebProviderReviewEligibilityResultSchema
>
export type MobileWebProviderReviewCreatePayload = z.infer<
  typeof MobileWebProviderReviewCreatePayloadSchema
>
export type MobileWebProviderReviewCreateResult = z.infer<
  typeof MobileWebProviderReviewCreateResultSchema
>
export type MobileWebProviderReviewFieldsPayload = z.infer<
  typeof MobileWebProviderReviewFieldsPayloadSchema
>
export type MobileWebProviderReviewFieldsResult = z.infer<
  typeof MobileWebProviderReviewFieldsResultSchema
>
