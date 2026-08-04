import { z } from 'zod'

export const FILESYSTEM_HOST_PROTOCOL_VERSION = 1
export const FILESYSTEM_HOST_MAX_TEXT_BYTES = 4 * 1024 * 1024
const FILESYSTEM_HOST_MAX_BASE64_BYTES = Math.ceil((FILESYSTEM_HOST_MAX_TEXT_BYTES * 4) / 3) + 4

const filesystemPathSchema = z.string().min(1).max(32_768)
const filesystemPathEnvironmentSchema = z.string().max(131_072)
const keybindingOverridesSchema = z
  .record(z.string().min(1).max(256), z.array(z.string().max(512)).max(16))
  .refine((value) => Object.keys(value).length <= 512)

export const filesystemCliCommandNameSchema = z.enum(['claude', 'codex'])
export const rateLimitCredentialFileKindSchema = z.enum([
  'gemini-oauth-credentials',
  'opencode-auth'
])

export const filesystemSnapshotFileKindSchema = z.enum([
  'claude-credentials',
  'codex-auth',
  'gemini-auth',
  'gemini-oauth-credentials',
  'grok-auth',
  'kimi-credentials',
  'minimax-cookie',
  'openai-speech-key'
])

export const filesystemHostOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('canonicalize-path'),
    path: filesystemPathSchema
  }),
  z.object({
    kind: z.literal('classify-path'),
    path: filesystemPathSchema
  }),
  z.object({
    kind: z.literal('read-orca-yaml'),
    path: filesystemPathSchema,
    maxBytes: z.number().int().positive().max(FILESYSTEM_HOST_MAX_TEXT_BYTES)
  }),
  z.object({
    kind: z.literal('read-keybindings'),
    path: filesystemPathSchema,
    maxBytes: z.number().int().positive().max(FILESYSTEM_HOST_MAX_TEXT_BYTES)
  }),
  z.object({
    kind: z.literal('prepare-keybindings'),
    path: filesystemPathSchema,
    platform: z.enum(['darwin', 'linux', 'win32']),
    legacyOverrides: keybindingOverridesSchema.optional(),
    seedLegacyTabSwitchBindings: z.boolean()
  }),
  z.object({
    kind: z.literal('read-snapshot-file'),
    path: filesystemPathSchema,
    fileKind: filesystemSnapshotFileKindSchema
  }),
  z.object({
    kind: z.literal('prepare-rate-limit-pty-cwd'),
    path: filesystemPathSchema
  }),
  z.object({
    kind: z.literal('resolve-cli-command'),
    path: filesystemPathSchema,
    commandName: filesystemCliCommandNameSchema,
    pathEnvironment: filesystemPathEnvironmentSchema
  }),
  z.object({
    kind: z.literal('write-rate-limit-credential'),
    path: filesystemPathSchema,
    fileKind: rateLimitCredentialFileKindSchema,
    contents: z.string().min(1).max(FILESYSTEM_HOST_MAX_TEXT_BYTES)
  })
])

const filesystemHostReadParentMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('request'),
    requestId: z.string().min(1).max(128),
    operation: filesystemHostOperationSchema
  }),
  z.object({ type: z.literal('shutdown') })
])

export const filesystemHostParentMessageSchema = filesystemHostReadParentMessageSchema

const filesystemHostResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('canonicalize-path'), canonicalPath: filesystemPathSchema }),
  z.object({ kind: z.literal('classify-path'), deviceId: z.string().min(1).max(256) }),
  z.object({
    kind: z.literal('read-orca-yaml'),
    contents: z.string().max(FILESYSTEM_HOST_MAX_TEXT_BYTES)
  }),
  z.object({
    kind: z.literal('read-keybindings'),
    contents: z.string().max(FILESYSTEM_HOST_MAX_TEXT_BYTES)
  }),
  z.object({
    kind: z.literal('prepare-keybindings'),
    contents: z.string().max(FILESYSTEM_HOST_MAX_TEXT_BYTES).nullable(),
    seedCompleted: z.boolean()
  }),
  z.object({
    kind: z.literal('read-snapshot-file'),
    contentsBase64: z.string().max(FILESYSTEM_HOST_MAX_BASE64_BYTES)
  }),
  z.object({ kind: z.literal('prepare-rate-limit-pty-cwd'), canonicalPath: filesystemPathSchema }),
  z.object({ kind: z.literal('resolve-cli-command'), command: filesystemPathSchema }),
  z.object({ kind: z.literal('write-rate-limit-credential') })
])

export const filesystemHostErrorCodeSchema = z.enum([
  'missing',
  'denied',
  'not-directory',
  'too-large',
  'invalid',
  'io'
])

const filesystemHostReadChildMessageSchema = z.union([
  z.object({
    type: z.literal('ready'),
    protocolVersion: z.literal(FILESYSTEM_HOST_PROTOCOL_VERSION),
    workerId: z.string().uuid()
  }),
  z.object({
    type: z.literal('result'),
    requestId: z.string().min(1).max(128),
    ok: z.literal(true),
    result: filesystemHostResultSchema
  }),
  z.object({
    type: z.literal('result'),
    requestId: z.string().min(1).max(128),
    ok: z.literal(false),
    error: z.object({
      code: filesystemHostErrorCodeSchema,
      message: z.string().max(2048)
    })
  })
])

export const filesystemHostChildMessageSchema = filesystemHostReadChildMessageSchema

export type FilesystemHostOperation = z.infer<typeof filesystemHostOperationSchema>
export type FilesystemHostParentMessage = z.infer<typeof filesystemHostParentMessageSchema>
export type FilesystemHostChildMessage = z.infer<typeof filesystemHostChildMessageSchema>
export type FilesystemHostResult = z.infer<typeof filesystemHostResultSchema>
export type FilesystemHostErrorCode = z.infer<typeof filesystemHostErrorCodeSchema>
export type FilesystemSnapshotFileKind = z.infer<typeof filesystemSnapshotFileKindSchema>
export type FilesystemCliCommandName = z.infer<typeof filesystemCliCommandNameSchema>
export type RateLimitCredentialFileKind = z.infer<typeof rateLimitCredentialFileKindSchema>
