import { z } from 'zod'
import {
  MobileWebRelativePathSchema,
  MobileWebWorkspaceIdSchema
} from './bridge-operation-contract'
import { isMobileWebBase64, isMobileWebSha256 } from './protocol-token-contract'

export const MOBILE_WEB_FILE_EDIT_MAX_BYTES = 128 * 1024
export const MOBILE_WEB_FILE_EDIT_MAX_BASE64_CHARACTERS =
  Math.ceil(MOBILE_WEB_FILE_EDIT_MAX_BYTES / 3) * 4

const MobileWebFileEditBase64Schema = z
  .string()
  .max(MOBILE_WEB_FILE_EDIT_MAX_BASE64_CHARACTERS)
  .refine(isBoundedBase64, 'Invalid file content')

export const MobileWebFileWritePayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    relativePath: MobileWebRelativePathSchema,
    expectedRevision: z.string().refine(isMobileWebSha256),
    contentBase64: MobileWebFileEditBase64Schema
  })
  .strict()

export const MobileWebFileWriteResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    relativePath: MobileWebRelativePathSchema,
    revision: z.string().refine(isMobileWebSha256),
    byteLength: z.number().int().nonnegative().max(MOBILE_WEB_FILE_EDIT_MAX_BYTES),
    outcome: z.literal('updated')
  })
  .strict()

export type MobileWebFileWritePayload = z.infer<typeof MobileWebFileWritePayloadSchema>
export type MobileWebFileWriteResult = z.infer<typeof MobileWebFileWriteResultSchema>

function isBoundedBase64(value: string): boolean {
  if (!isMobileWebBase64(value)) {
    return false
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding <= MOBILE_WEB_FILE_EDIT_MAX_BYTES
}
