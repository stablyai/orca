import { z } from 'zod'
import { MobileWebWorkspaceIdSchema } from './bridge-operation-contract'
import { MobileWebSourceControlStatusEntrySchema } from './source-control-operation-contract'

export const MOBILE_WEB_SOURCE_CONTROL_MUTATION_LIMIT = 32

export const MobileWebSourceControlMutationOperationSchema = z.enum(['stage', 'unstage', 'discard'])

/** The Desktop decides whether a path may be staged, unstaged or discarded; the page sends the
 * paths it saw and reads the refusal back from the Desktop. */
export const MobileWebSourceControlMutationPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    relativePaths: z
      .array(MobileWebSourceControlStatusEntrySchema.shape.relativePath)
      .min(1)
      .max(MOBILE_WEB_SOURCE_CONTROL_MUTATION_LIMIT)
      .refine((paths) => new Set(paths).size === paths.length, 'Duplicate mutation path')
  })
  .strict()

export type MobileWebSourceControlMutationOperation = z.infer<
  typeof MobileWebSourceControlMutationOperationSchema
>
export type MobileWebSourceControlMutationPayload = z.infer<
  typeof MobileWebSourceControlMutationPayloadSchema
>
