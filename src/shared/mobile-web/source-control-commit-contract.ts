import { z } from 'zod'
import { MobileWebWorkspaceIdSchema } from './bridge-operation-contract'
import { isMobileWebGitObjectId } from './protocol-token-contract'

export const MOBILE_WEB_COMMIT_MESSAGE_MAX_CHARACTERS = 10_000
export const MOBILE_WEB_COMMIT_RESULT_ERROR_MAX_CHARACTERS = 2_000
export const MOBILE_WEB_COMMIT_AGENT_LABEL_MAX_CHARACTERS = 160

const FullGitObjectIdSchema = z.string().refine(isMobileWebGitObjectId)

export const MobileWebSourceControlCommitPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    message: z
      .string()
      .max(MOBILE_WEB_COMMIT_MESSAGE_MAX_CHARACTERS)
      .refine((message) => message.trim().length > 0, 'Commit message is required')
  })
  .strict()

/** The Desktop reports a refused commit in the result, not as an RPC error, so the page reads both
 * outcomes from the same shape it would get on a native route. Git's failure text is whatever the
 * hook printed, so it is clipped rather than rejected. */
export const MobileWebSourceControlCommitResultSchema = z.object({
  success: z.boolean(),
  error: z
    .string()
    .transform((error) => error.slice(0, MOBILE_WEB_COMMIT_RESULT_ERROR_MAX_CHARACTERS))
    .optional()
})

export const MobileWebSourceControlGenerateCommitMessagePayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    expectedHead: FullGitObjectIdSchema
  })
  .strict()

export const MobileWebSourceControlCancelCommitMessagePayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()

const CommitResultIdentityShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  previousHead: FullGitObjectIdSchema
} as const

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

export type MobileWebSourceControlCommitPayload = z.infer<
  typeof MobileWebSourceControlCommitPayloadSchema
>
export type MobileWebSourceControlCommitResult = z.infer<
  typeof MobileWebSourceControlCommitResultSchema
>
export type MobileWebSourceControlGenerateCommitMessagePayload = z.infer<
  typeof MobileWebSourceControlGenerateCommitMessagePayloadSchema
>
export type MobileWebSourceControlCancelCommitMessagePayload = z.infer<
  typeof MobileWebSourceControlCancelCommitMessagePayloadSchema
>
export type MobileWebSourceControlGenerateCommitMessageResult = z.infer<
  typeof MobileWebSourceControlGenerateCommitMessageResultSchema
>
export type MobileWebSourceControlCancelCommitMessageResult = z.infer<
  typeof MobileWebSourceControlCancelCommitMessageResultSchema
>
