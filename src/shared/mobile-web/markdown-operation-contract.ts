import { z } from 'zod'
import { MOBILE_MARKDOWN_EDIT_MAX_BYTES } from '../mobile-markdown-document'
import { MobileWebRelativePathSchema } from './file-operation-contract'
import { isMobileWebBase64 } from './protocol-token-contract'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

export const MOBILE_WEB_MARKDOWN_CONTENT_MAX_BASE64_CHARACTERS =
  Math.ceil(MOBILE_MARKDOWN_EDIT_MAX_BYTES / 3) * 4

const MobileWebMarkdownBase64Schema = z
  .string()
  .max(MOBILE_WEB_MARKDOWN_CONTENT_MAX_BASE64_CHARACTERS)
  .refine(isMobileWebBase64, 'Invalid base64')

/**
 * A markdown tab is addressed by `tabId` alone: the shell resolves the file from its authoritative
 * `session.tabs.list`, so the page can neither name a host path nor be locked out of tabs whose
 * host path is not worktree-relative (files opened from outside the worktree). `relativePath` is
 * an echo for display and draft keys, present only when the host path really is relative.
 */
const MobileWebMarkdownTargetShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  tabId: z.string().min(1).max(512),
  relativePath: MobileWebRelativePathSchema.optional()
} as const

const MobileWebMarkdownResultTargetShape = {
  ...MobileWebMarkdownTargetShape
} as const

export const MobileWebMarkdownReadPayloadSchema = z
  .object({
    ...MobileWebMarkdownTargetShape,
    tabIsDirty: z.boolean()
  })
  .strict()

export const MobileWebMarkdownReadResultSchema = z
  .object({
    ...MobileWebMarkdownResultTargetShape,
    contentBase64: MobileWebMarkdownBase64Schema,
    baseVersion: z.string().max(512),
    editable: z.boolean(),
    stale: z.boolean(),
    readOnlyReason: z.string().min(1).max(256).optional()
  })
  .strict()

export const MobileWebMarkdownSavePayloadSchema = z
  .object({
    ...MobileWebMarkdownTargetShape,
    baseVersion: z.string().min(1).max(512),
    contentBase64: MobileWebMarkdownBase64Schema
  })
  .strict()

export const MobileWebMarkdownSaveResultSchema = z
  .object({
    ...MobileWebMarkdownResultTargetShape,
    contentBase64: MobileWebMarkdownBase64Schema,
    baseVersion: z.string().min(1).max(512)
  })
  .strict()

export const MobileWebMarkdownDraftSchema = z
  .object({
    contentBase64: MobileWebMarkdownBase64Schema,
    baseVersion: z.string().min(1).max(512)
  })
  .strict()

export const MobileWebMarkdownDraftReadPayloadSchema = z
  .object(MobileWebMarkdownTargetShape)
  .strict()
export const MobileWebMarkdownDraftReadResultSchema = z
  .object({
    ...MobileWebMarkdownResultTargetShape,
    draft: MobileWebMarkdownDraftSchema.nullable()
  })
  .strict()
export const MobileWebMarkdownDraftWritePayloadSchema = z
  .object({
    ...MobileWebMarkdownTargetShape,
    draft: MobileWebMarkdownDraftSchema.nullable()
  })
  .strict()
export const MobileWebMarkdownDraftWriteResultSchema = z.null()

export type MobileWebMarkdownReadPayload = z.infer<typeof MobileWebMarkdownReadPayloadSchema>
export type MobileWebMarkdownReadWireResult = z.infer<typeof MobileWebMarkdownReadResultSchema>
export type MobileWebMarkdownSaveWireResult = z.infer<typeof MobileWebMarkdownSaveResultSchema>
export type MobileWebMarkdownDraftWire = z.infer<typeof MobileWebMarkdownDraftSchema>
export type MobileWebMarkdownDraftReadPayload = z.infer<
  typeof MobileWebMarkdownDraftReadPayloadSchema
>
