import { z } from 'zod'
import { isMobileWebGitObjectId } from './protocol-token-contract'
import { MobileWebGitRefNameSchema } from './source-control-history-contract'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

const ProviderSchema = z.enum(['github', 'gitlab', 'bitbucket', 'azure-devops', 'gitea'])
const HeadSchema = z.string().refine(isMobileWebGitObjectId)
const PositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const NullableTextSchema = (limit: number) => z.string().max(limit).nullable()

const QueryIdentityShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  expectedHead: HeadSchema,
  expectedBranch: MobileWebGitRefNameSchema,
  provider: ProviderSchema,
  reviewNumber: PositiveIntegerSchema
} as const

export const MobileWebProviderReviewQueryPayloadSchema = z.discriminatedUnion('query', [
  z.object({ ...QueryIdentityShape, query: z.literal('assignableUsers') }).strict(),
  z
    .object({
      ...QueryIdentityShape,
      query: z.literal('checkDetails'),
      checkRunId: PositiveIntegerSchema.optional(),
      workflowRunId: PositiveIntegerSchema.optional(),
      checkName: z.string().min(1).max(256)
    })
    .strict()
])

const UserSchema = z
  .object({
    login: z.string().min(1).max(80),
    name: z.string().max(160).nullable()
  })
  .strict()

const AnnotationSchema = z
  .object({
    path: NullableTextSchema(1024),
    startLine: PositiveIntegerSchema.nullable(),
    endLine: PositiveIntegerSchema.nullable(),
    annotationLevel: NullableTextSchema(80),
    title: NullableTextSchema(512),
    message: z.string().max(8 * 1024)
  })
  .strict()

const StepSchema = z
  .object({
    name: z.string().max(256),
    status: NullableTextSchema(80),
    conclusion: NullableTextSchema(80)
  })
  .strict()

const JobSchema = z
  .object({
    name: z.string().max(256),
    status: NullableTextSchema(80),
    conclusion: NullableTextSchema(80),
    logTail: NullableTextSchema(32 * 1024),
    steps: z.array(StepSchema).max(100)
  })
  .strict()

const CheckDetailsSchema = z
  .object({
    name: z.string().min(1).max(256),
    status: NullableTextSchema(80),
    conclusion: NullableTextSchema(80),
    startedAt: NullableTextSchema(64),
    completedAt: NullableTextSchema(64),
    title: NullableTextSchema(512),
    summary: NullableTextSchema(16 * 1024),
    annotations: z.array(AnnotationSchema).max(20),
    jobs: z.array(JobSchema).max(100)
  })
  .strict()

const ResultIdentityShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  provider: ProviderSchema,
  reviewNumber: PositiveIntegerSchema
} as const

export const MobileWebProviderReviewQueryResultSchema = z.discriminatedUnion('query', [
  z
    .object({
      ...ResultIdentityShape,
      query: z.literal('assignableUsers'),
      users: z.array(UserSchema).max(64)
    })
    .strict(),
  z
    .object({
      ...ResultIdentityShape,
      query: z.literal('checkDetails'),
      details: CheckDetailsSchema.nullable()
    })
    .strict()
])

export type MobileWebProviderReviewQueryPayload = z.infer<
  typeof MobileWebProviderReviewQueryPayloadSchema
>
export type MobileWebProviderReviewQueryResult = z.infer<
  typeof MobileWebProviderReviewQueryResultSchema
>
