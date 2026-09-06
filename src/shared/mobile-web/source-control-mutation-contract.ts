import { z } from 'zod'
import { MobileWebWorkspaceIdSchema } from './bridge-operation-contract'
import { isMobileWebGitObjectId } from './protocol-token-contract'
import { MobileWebSourceControlStatusEntrySchema } from './source-control-operation-contract'

export const MOBILE_WEB_SOURCE_CONTROL_MUTATION_LIMIT = 32

export const MobileWebSourceControlMutationOperationSchema = z.enum(['stage', 'unstage', 'discard'])

export const MobileWebSourceControlMutationEntrySchema =
  MobileWebSourceControlStatusEntrySchema.pick({
    relativePath: true,
    oldRelativePath: true,
    status: true,
    area: true,
    conflictStatus: true
  })

const ExpectedHeadSchema = z.string().refine(isMobileWebGitObjectId).nullable()

const MutationPayloadShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  expectedHead: ExpectedHeadSchema,
  entries: z
    .array(MobileWebSourceControlMutationEntrySchema)
    .min(1)
    .max(MOBILE_WEB_SOURCE_CONTROL_MUTATION_LIMIT)
} as const

export const MobileWebSourceControlStagePayloadSchema = z
  .object(MutationPayloadShape)
  .strict()
  .superRefine((payload, context) => {
    validateUniquePaths(payload.entries, context)
    payload.entries.forEach((entry, index) => {
      if (entry.area === 'staged' || entry.conflictStatus === 'unresolved') {
        context.addIssue({
          code: 'custom',
          message: 'Entry cannot be staged',
          path: ['entries', index]
        })
      }
    })
  })

export const MobileWebSourceControlUnstagePayloadSchema = z
  .object(MutationPayloadShape)
  .strict()
  .superRefine((payload, context) => {
    validateUniquePaths(payload.entries, context)
    payload.entries.forEach((entry, index) => {
      if (entry.area !== 'staged') {
        context.addIssue({
          code: 'custom',
          message: 'Entry cannot be unstaged',
          path: ['entries', index]
        })
      }
    })
  })

export const MobileWebSourceControlDiscardPayloadSchema = z
  .object({
    ...MutationPayloadShape,
    confirmation: z.literal('discard-confirmed')
  })
  .strict()
  .superRefine((payload, context) => {
    validateUniquePaths(payload.entries, context)
    payload.entries.forEach((entry, index) => {
      if (entry.area === 'staged' || entry.conflictStatus === 'unresolved') {
        context.addIssue({
          code: 'custom',
          message: 'Entry cannot be discarded',
          path: ['entries', index]
        })
      }
    })
  })

export const MobileWebSourceControlMutationResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    operation: MobileWebSourceControlMutationOperationSchema,
    relativePaths: z
      .array(MobileWebSourceControlStatusEntrySchema.shape.relativePath)
      .min(1)
      .max(MOBILE_WEB_SOURCE_CONTROL_MUTATION_LIMIT),
    mutated: z.literal(true)
  })
  .strict()

export type MobileWebSourceControlMutationOperation = z.infer<
  typeof MobileWebSourceControlMutationOperationSchema
>
export type MobileWebSourceControlMutationEntry = z.infer<
  typeof MobileWebSourceControlMutationEntrySchema
>
export type MobileWebSourceControlStagePayload = z.infer<
  typeof MobileWebSourceControlStagePayloadSchema
>
export type MobileWebSourceControlUnstagePayload = z.infer<
  typeof MobileWebSourceControlUnstagePayloadSchema
>
export type MobileWebSourceControlDiscardPayload = z.infer<
  typeof MobileWebSourceControlDiscardPayloadSchema
>
export type MobileWebSourceControlMutationResult = z.infer<
  typeof MobileWebSourceControlMutationResultSchema
>

function validateUniquePaths(
  entries: readonly { relativePath: string }[],
  context: z.RefinementCtx
): void {
  const paths = new Set<string>()
  entries.forEach((entry, index) => {
    if (paths.has(entry.relativePath)) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate mutation path',
        path: ['entries', index, 'relativePath']
      })
    }
    paths.add(entry.relativePath)
  })
}
