import { z } from 'zod'
import { MobileWebWorkspaceIdSchema } from './bridge-operation-contract'
import { isMobileWebGitObjectId } from './protocol-token-contract'
import { MobileWebSourceControlMutationEntrySchema } from './source-control-mutation-contract'

export const MOBILE_WEB_COMMIT_MESSAGE_MAX_CHARACTERS = 10_000
export const MOBILE_WEB_COMMIT_RESULT_ERROR_MAX_CHARACTERS = 2_000
export const MOBILE_WEB_COMMIT_AGENT_LABEL_MAX_CHARACTERS = 160
export const MOBILE_WEB_COMMIT_STAGED_ENTRY_LIMIT = 64

const FullGitObjectIdSchema = z.string().refine(isMobileWebGitObjectId)

export const MobileWebSourceControlCommitEntrySchema =
  MobileWebSourceControlMutationEntrySchema.extend({
    area: z.literal('staged')
  }).superRefine((entry, context) => {
    if (entry.conflictStatus === 'unresolved') {
      context.addIssue({ code: 'custom', message: 'Unresolved entries cannot be committed' })
    }
  })

const CommitSnapshotShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  expectedHead: FullGitObjectIdSchema,
  stagedEntries: z
    .array(MobileWebSourceControlCommitEntrySchema)
    .min(1)
    .max(MOBILE_WEB_COMMIT_STAGED_ENTRY_LIMIT)
} as const

export const MobileWebSourceControlCommitPayloadSchema = z
  .object({
    ...CommitSnapshotShape,
    message: z
      .string()
      .max(MOBILE_WEB_COMMIT_MESSAGE_MAX_CHARACTERS)
      .refine((message) => message.trim().length > 0, 'Commit message is required')
  })
  .strict()
  .superRefine(validateUniqueStagedEntries)

export const MobileWebSourceControlGenerateCommitMessagePayloadSchema = z
  .object(CommitSnapshotShape)
  .strict()
  .superRefine(validateUniqueStagedEntries)

export const MobileWebSourceControlCancelCommitMessagePayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()

const CommitResultIdentityShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  previousHead: FullGitObjectIdSchema
} as const

export const MobileWebSourceControlCommitResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...CommitResultIdentityShape,
      status: z.literal('committed'),
      head: FullGitObjectIdSchema.nullable()
    })
    .strict(),
  z
    .object({
      ...CommitResultIdentityShape,
      status: z.literal('failed'),
      error: z.string().min(1).max(MOBILE_WEB_COMMIT_RESULT_ERROR_MAX_CHARACTERS)
    })
    .strict()
])

export const MobileWebSourceControlGenerateCommitMessageResultSchema = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        ...CommitResultIdentityShape,
        status: z.literal('generated'),
        message: z.string().min(1).max(MOBILE_WEB_COMMIT_MESSAGE_MAX_CHARACTERS),
        agentLabel: z.string().min(1).max(MOBILE_WEB_COMMIT_AGENT_LABEL_MAX_CHARACTERS).optional()
      })
      .strict(),
    z
      .object({
        ...CommitResultIdentityShape,
        status: z.literal('failed'),
        error: z.string().min(1).max(MOBILE_WEB_COMMIT_RESULT_ERROR_MAX_CHARACTERS)
      })
      .strict(),
    z
      .object({
        ...CommitResultIdentityShape,
        status: z.literal('cancelled')
      })
      .strict()
  ]
)

export const MobileWebSourceControlCancelCommitMessageResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    cancellationRequested: z.literal(true)
  })
  .strict()

export type MobileWebSourceControlCommitEntry = z.infer<
  typeof MobileWebSourceControlCommitEntrySchema
>
export type MobileWebSourceControlCommitPayload = z.infer<
  typeof MobileWebSourceControlCommitPayloadSchema
>
export type MobileWebSourceControlGenerateCommitMessagePayload = z.infer<
  typeof MobileWebSourceControlGenerateCommitMessagePayloadSchema
>
export type MobileWebSourceControlCancelCommitMessagePayload = z.infer<
  typeof MobileWebSourceControlCancelCommitMessagePayloadSchema
>
export type MobileWebSourceControlCommitResult = z.infer<
  typeof MobileWebSourceControlCommitResultSchema
>
export type MobileWebSourceControlGenerateCommitMessageResult = z.infer<
  typeof MobileWebSourceControlGenerateCommitMessageResultSchema
>
export type MobileWebSourceControlCancelCommitMessageResult = z.infer<
  typeof MobileWebSourceControlCancelCommitMessageResultSchema
>

function validateUniqueStagedEntries(
  payload: { stagedEntries: readonly { relativePath: string }[] },
  context: z.RefinementCtx
): void {
  const paths = new Set<string>()
  payload.stagedEntries.forEach((entry, index) => {
    if (paths.has(entry.relativePath)) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate staged path',
        path: ['stagedEntries', index, 'relativePath']
      })
    }
    paths.add(entry.relativePath)
  })
}
