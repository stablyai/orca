import { z } from 'zod'
import {
  MOBILE_WEB_FILE_CHUNK_MAX_BYTES,
  MobileWebRelativePathSchema,
  MobileWebWorkspaceIdSchema
} from './bridge-operation-contract'
import { isMobileWebBase64, isMobileWebBase64UrlIdentifier } from './protocol-token-contract'

export const MOBILE_WEB_TERMINAL_PATH_MAX_CHARACTERS = 1024
export const MOBILE_WEB_TERMINAL_ARTIFACT_MAX_RECORDS = 32
export const MOBILE_WEB_TERMINAL_ARTIFACT_TTL_MS = 2 * 60 * 1000
export const MOBILE_WEB_TERMINAL_ARTIFACT_TEXT_MAX_BYTES = 1024 * 1024
export const MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES = 2 * 1024 * 1024

const TerminalArtifactTokenSchema = z
  .string()
  .refine((value) => isMobileWebBase64UrlIdentifier(value, 43))
const TerminalTabIdSchema = z.string().min(1).max(512)
const TerminalLocationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable()
const TerminalArtifactDisplayNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      ![...value].some(
        (character) => isControlCharacter(character) || character === '/' || character === '\\'
      ),
    'Invalid artifact display name'
  )
const TerminalArtifactPreviewKindSchema = z.enum(['text', 'raster'])
const TerminalPathTextSchema = z
  .string()
  .min(1)
  .max(MOBILE_WEB_TERMINAL_PATH_MAX_CHARACTERS)
  .refine((value) => ![...value].some(isControlCharacter), 'Invalid terminal path')
const TerminalArtifactBase64Schema = z
  .string()
  .max(Math.ceil(MOBILE_WEB_FILE_CHUNK_MAX_BYTES / 3) * 4)
  .refine(isMobileWebBase64, 'Invalid base64')
  .refine(hasCanonicalBase64Padding, 'Non-canonical base64')

export const MobileWebTerminalPathResolvePayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    tabId: TerminalTabIdSchema,
    pathText: TerminalPathTextSchema,
    line: TerminalLocationSchema,
    column: TerminalLocationSchema
  })
  .strict()

const MobileWebTerminalPathResultBase = {
  workspaceId: MobileWebWorkspaceIdSchema,
  displayName: TerminalArtifactDisplayNameSchema,
  previewKind: TerminalArtifactPreviewKindSchema,
  line: TerminalLocationSchema,
  column: TerminalLocationSchema
} as const

export const MobileWebTerminalPathResolveResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...MobileWebTerminalPathResultBase,
      kind: z.literal('worktree-file'),
      relativePath: MobileWebRelativePathSchema
    })
    .strict(),
  z
    .object({
      ...MobileWebTerminalPathResultBase,
      kind: z.literal('terminal-artifact'),
      token: TerminalArtifactTokenSchema
    })
    .strict()
])

export const MobileWebTerminalArtifactChunkPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    tabId: TerminalTabIdSchema,
    token: TerminalArtifactTokenSchema,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    length: z.number().int().min(1).max(MOBILE_WEB_FILE_CHUNK_MAX_BYTES)
  })
  .strict()

export const MobileWebTerminalArtifactChunkResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    tabId: TerminalTabIdSchema,
    token: TerminalArtifactTokenSchema,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contentBase64: TerminalArtifactBase64Schema,
    bytesRead: z.number().int().nonnegative().max(MOBILE_WEB_FILE_CHUNK_MAX_BYTES),
    eof: z.boolean()
  })
  .strict()
  .superRefine((result, context) => {
    if (decodedBase64Length(result.contentBase64) !== result.bytesRead) {
      context.addIssue({ code: 'custom', message: 'Artifact chunk length mismatch' })
    }
    if (result.bytesRead === 0 && !result.eof) {
      context.addIssue({ code: 'custom', message: 'Empty artifact chunk must be EOF' })
    }
  })

export const MobileWebTerminalArtifactReleasePayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    tabId: TerminalTabIdSchema,
    token: TerminalArtifactTokenSchema
  })
  .strict()

export const MobileWebTerminalArtifactReleaseResultSchema = z.null()

export type MobileWebTerminalPathResolvePayload = z.infer<
  typeof MobileWebTerminalPathResolvePayloadSchema
>
export type MobileWebTerminalPathResolveResult = z.infer<
  typeof MobileWebTerminalPathResolveResultSchema
>
export type MobileWebTerminalArtifactChunkPayload = z.infer<
  typeof MobileWebTerminalArtifactChunkPayloadSchema
>
export type MobileWebTerminalArtifactChunkWireResult = z.infer<
  typeof MobileWebTerminalArtifactChunkResultSchema
>
export type MobileWebTerminalArtifactChunkResult = Omit<
  MobileWebTerminalArtifactChunkWireResult,
  'contentBase64'
> & { bytes: Uint8Array }
export type MobileWebTerminalArtifactReleasePayload = z.infer<
  typeof MobileWebTerminalArtifactReleasePayloadSchema
>

function decodedBase64Length(value: string): number {
  if (!value) {
    return 0
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function hasCanonicalBase64Padding(value: string): boolean {
  if (value.endsWith('==')) {
    return base64Value(value.at(-3)) % 16 === 0
  }
  if (value.endsWith('=')) {
    return base64Value(value.at(-2)) % 4 === 0
  }
  return true
}

function base64Value(value: string | undefined): number {
  if (!value) {
    return -1
  }
  const code = value.charCodeAt(0)
  if (code >= 65 && code <= 90) {
    return code - 65
  }
  if (code >= 97 && code <= 122) {
    return code - 71
  }
  if (code >= 48 && code <= 57) {
    return code + 4
  }
  return value === '+' ? 62 : value === '/' ? 63 : -1
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0)
  return code < 32 || code === 127
}
