import { z } from 'zod'
import { MobileWebRelativePathSchema } from './file-operation-contract'
import { isMobileWebGitObjectId, isMobileWebSha256 } from './protocol-token-contract'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

export const MOBILE_WEB_SOURCE_CONTROL_STATUS_LIMIT = 64
export const MOBILE_WEB_DIFF_PAGE_LIMIT = 96
export const MOBILE_WEB_DIFF_MAX_ROWS = 4_000
export const MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS = 1_024
export const MOBILE_WEB_DIFF_INPUT_MAX_CHARACTERS = 2_000_000
export const MOBILE_WEB_DIFF_SOURCE_LINE_LIMIT = 20_000

export const MobileWebGitFileStatusSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
  'copied'
])
export const MobileWebGitStagingAreaSchema = z.enum(['staged', 'unstaged', 'untracked'])

export const MobileWebSourceControlStatusPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(MOBILE_WEB_SOURCE_CONTROL_STATUS_LIMIT)
      .default(MOBILE_WEB_SOURCE_CONTROL_STATUS_LIMIT)
  })
  .strict()

export const MobileWebSourceControlSubscribePayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()

export const MobileWebSourceControlStatusInvalidationSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    reason: z.enum(['changed', 'overflow', 'unavailable'])
  })
  .strict()

export const MobileWebSourceControlStatusEntrySchema = z
  .object({
    relativePath: MobileWebRelativePathSchema,
    oldRelativePath: MobileWebRelativePathSchema.optional(),
    status: MobileWebGitFileStatusSchema,
    area: MobileWebGitStagingAreaSchema,
    conflictStatus: z.enum(['unresolved', 'resolved_locally']).optional(),
    added: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    removed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

export const MobileWebSourceControlStatusResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    branch: z.string().min(1).max(240).optional(),
    head: z.string().refine(isMobileWebGitObjectId).optional(),
    conflictOperation: z.enum(['merge', 'rebase', 'cherry-pick', 'unknown']),
    entries: z
      .array(MobileWebSourceControlStatusEntrySchema)
      .max(MOBILE_WEB_SOURCE_CONTROL_STATUS_LIMIT),
    totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    truncated: z.boolean()
  })
  .strict()

export const MobileWebSourceControlDiffPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    relativePath: MobileWebRelativePathSchema,
    area: MobileWebGitStagingAreaSchema,
    offset: z.number().int().min(0).max(MOBILE_WEB_DIFF_MAX_ROWS).default(0),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MOBILE_WEB_DIFF_PAGE_LIMIT)
      .default(MOBILE_WEB_DIFF_PAGE_LIMIT),
    expectedRevision: z.string().refine(isMobileWebSha256).optional()
  })
  .strict()

export const MobileWebDiffRowSchema = z
  .object({
    index: z
      .number()
      .int()
      .min(0)
      .max(MOBILE_WEB_DIFF_MAX_ROWS - 1),
    kind: z.enum(['context', 'add', 'delete']),
    text: z.string().max(MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS),
    textTruncated: z.boolean(),
    oldLineNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    newLineNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

const MobileWebSourceControlDiffIdentityShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  relativePath: MobileWebRelativePathSchema,
  area: MobileWebGitStagingAreaSchema
} as const

const MobileWebSourceControlTextDiffResultSchema = z
  .object({
    ...MobileWebSourceControlDiffIdentityShape,
    kind: z.literal('text'),
    revision: z.string().refine(isMobileWebSha256),
    offset: z.number().int().min(0).max(MOBILE_WEB_DIFF_MAX_ROWS),
    totalRows: z.number().int().min(0).max(MOBILE_WEB_DIFF_MAX_ROWS),
    rows: z.array(MobileWebDiffRowSchema).max(MOBILE_WEB_DIFF_PAGE_LIMIT),
    nextOffset: z.number().int().min(1).max(MOBILE_WEB_DIFF_MAX_ROWS).nullable(),
    truncated: z.boolean()
  })
  .strict()

const MobileWebSourceControlBinaryDiffResultSchema = z
  .object({
    ...MobileWebSourceControlDiffIdentityShape,
    kind: z.literal('binary')
  })
  .strict()

const MobileWebSourceControlLargeDiffResultSchema = z
  .object({
    ...MobileWebSourceControlDiffIdentityShape,
    kind: z.literal('too-large'),
    reason: z.enum(['host-limit', 'mobile-limit']),
    characterCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

export const MobileWebSourceControlDiffResultSchema = z.discriminatedUnion('kind', [
  MobileWebSourceControlTextDiffResultSchema,
  MobileWebSourceControlBinaryDiffResultSchema,
  MobileWebSourceControlLargeDiffResultSchema
])

export type MobileWebSourceControlStatusPayload = z.infer<
  typeof MobileWebSourceControlStatusPayloadSchema
>
export type MobileWebSourceControlSubscribePayload = z.infer<
  typeof MobileWebSourceControlSubscribePayloadSchema
>
export type MobileWebSourceControlStatusInvalidation = z.infer<
  typeof MobileWebSourceControlStatusInvalidationSchema
>
export type MobileWebSourceControlStatusEntry = z.infer<
  typeof MobileWebSourceControlStatusEntrySchema
>
export type MobileWebSourceControlStatusResult = z.infer<
  typeof MobileWebSourceControlStatusResultSchema
>
export type MobileWebSourceControlDiffPayload = z.infer<
  typeof MobileWebSourceControlDiffPayloadSchema
>
export type MobileWebDiffRow = z.infer<typeof MobileWebDiffRowSchema>
export type MobileWebSourceControlDiffResult = z.infer<
  typeof MobileWebSourceControlDiffResultSchema
>
