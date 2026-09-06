import { z } from 'zod'
import { isMobileWebBase64, isMobileWebSha256 } from './protocol-token-contract'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

export const MOBILE_WEB_FILE_LIST_LIMIT = 32
export const MOBILE_WEB_FILE_DIRECTORY_LIMIT = 128
export const MOBILE_WEB_FILE_CONTENT_MAX_BYTES = 176 * 1024
export const MOBILE_WEB_FILE_CONTENT_MAX_BASE64_CHARS =
  Math.ceil(MOBILE_WEB_FILE_CONTENT_MAX_BYTES / 3) * 4
export const MOBILE_WEB_FILE_CHUNK_MAX_BYTES = 128 * 1024
export const MOBILE_WEB_FILE_CHUNK_MAX_BASE64_CHARS =
  Math.ceil(MOBILE_WEB_FILE_CHUNK_MAX_BYTES / 3) * 4

export const MobileWebRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafeRelativePath, 'Invalid relative path')
const MobileWebDirectoryPathSchema = z
  .string()
  .max(1024)
  .refine((value) => value === '' || isSafeRelativePath(value), 'Invalid directory path')
const MobileWebFileBase64Schema = boundedBase64Schema(MOBILE_WEB_FILE_CONTENT_MAX_BASE64_CHARS)
const MobileWebFileChunkBase64Schema = boundedBase64Schema(MOBILE_WEB_FILE_CHUNK_MAX_BASE64_CHARS)

const MobileWebFileListBaseSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    limit: z.number().int().min(1).max(MOBILE_WEB_FILE_LIST_LIMIT).default(32)
  })
  .strict()

export const MobileWebFileListPayloadSchema = MobileWebFileListBaseSchema
export const MobileWebFileSearchPayloadSchema = MobileWebFileListBaseSchema.extend({
  query: z.string().max(256)
}).strict()

export const MobileWebFileEntrySchema = z
  .object({
    relativePath: MobileWebRelativePathSchema,
    basename: z.string().min(1).max(255),
    kind: z.enum(['text', 'binary'])
  })
  .strict()

export const MobileWebFileListResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    files: z.array(MobileWebFileEntrySchema).max(MOBILE_WEB_FILE_LIST_LIMIT),
    totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    truncated: z.boolean()
  })
  .strict()

export const MobileWebFileReadPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    relativePath: MobileWebRelativePathSchema
  })
  .strict()
export const MobileWebFileOpenPayloadSchema = MobileWebFileReadPayloadSchema
export const MobileWebFileOpenResultSchema = z.null()

export const MobileWebFileReadResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    relativePath: MobileWebRelativePathSchema,
    contentBase64: MobileWebFileBase64Schema,
    truncated: z.boolean(),
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

export const MobileWebFileDirectoryPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    relativePath: MobileWebDirectoryPathSchema.default(''),
    limit: z.number().int().min(1).max(MOBILE_WEB_FILE_DIRECTORY_LIMIT).default(128)
  })
  .strict()

export const MobileWebFileDirectoryEntrySchema = z
  .object({
    name: z.string().min(1).max(255).refine(isSafePathSegment, 'Invalid directory entry'),
    isDirectory: z.boolean(),
    isSymlink: z.boolean()
  })
  .strict()

export const MobileWebFileDirectoryResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    relativePath: MobileWebDirectoryPathSchema,
    revision: z.string().refine(isMobileWebSha256),
    entries: z.array(MobileWebFileDirectoryEntrySchema).max(MOBILE_WEB_FILE_DIRECTORY_LIMIT),
    truncated: z.boolean()
  })
  .strict()

export const MobileWebFileChunkPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    relativePath: MobileWebRelativePathSchema,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    length: z.number().int().min(1).max(MOBILE_WEB_FILE_CHUNK_MAX_BYTES)
  })
  .strict()

export const MobileWebFileChunkResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    relativePath: MobileWebRelativePathSchema,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contentBase64: MobileWebFileChunkBase64Schema,
    bytesRead: z.number().int().nonnegative().max(MOBILE_WEB_FILE_CHUNK_MAX_BYTES),
    eof: z.boolean()
  })
  .strict()
  .superRefine((result, context) => {
    if (decodedBase64Length(result.contentBase64) !== result.bytesRead) {
      context.addIssue({ code: 'custom', message: 'Chunk length mismatch' })
    }
  })

export type MobileWebFileListPayload = z.infer<typeof MobileWebFileListPayloadSchema>
export type MobileWebFileSearchPayload = z.infer<typeof MobileWebFileSearchPayloadSchema>
export type MobileWebFileEntry = z.infer<typeof MobileWebFileEntrySchema>
export type MobileWebFileListResult = z.infer<typeof MobileWebFileListResultSchema>
export type MobileWebFileReadPayload = z.infer<typeof MobileWebFileReadPayloadSchema>
export type MobileWebFileOpenPayload = z.infer<typeof MobileWebFileOpenPayloadSchema>
export type MobileWebFileReadWireResult = z.infer<typeof MobileWebFileReadResultSchema>
export type MobileWebFileReadResult = Omit<MobileWebFileReadWireResult, 'contentBase64'> & {
  content: string
}
export type MobileWebFileDirectoryPayload = z.infer<typeof MobileWebFileDirectoryPayloadSchema>
export type MobileWebFileDirectoryEntry = z.infer<typeof MobileWebFileDirectoryEntrySchema>
export type MobileWebFileDirectoryResult = z.infer<typeof MobileWebFileDirectoryResultSchema>
export type MobileWebFileChunkPayload = z.infer<typeof MobileWebFileChunkPayloadSchema>
export type MobileWebFileChunkWireResult = z.infer<typeof MobileWebFileChunkResultSchema>
export type MobileWebFileChunkResult = Omit<MobileWebFileChunkWireResult, 'contentBase64'> & {
  bytes: Uint8Array
}

function boundedBase64Schema(maximum: number) {
  return z.string().max(maximum).refine(isMobileWebBase64, 'Invalid base64')
}

function decodedBase64Length(value: string): number {
  if (!value) {
    return 0
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function isSafeRelativePath(value: string): boolean {
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false
  }
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function isSafePathSegment(value: string): boolean {
  return (
    value !== '.' &&
    value !== '..' &&
    !value.includes('\0') &&
    !value.includes('/') &&
    !value.includes('\\')
  )
}
