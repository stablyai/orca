import { z } from 'zod'

export const BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION = 1 as const
export const BROWSER_CLIENT_FILE_CHANNEL_HOST_CAPABILITY = 'file-channel-v1' as const

// Why: base64 inflates 4/3, so a raw chunk this size stays well inside the runtime RPC envelope.
export const BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES = 128 * 1024
export const BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES = 64 * 1024 * 1024
export const BROWSER_CLIENT_FILE_CHANNEL_MAX_FILES_PER_COMMAND = 16
export const BROWSER_CLIENT_FILE_CHANNEL_MAX_ACTIVE_DOWNLOADS = 8

const Identity = z.string().min(1).max(256)
const Generation = z.number().int().min(1).max(0xffff_ffff)
const FileChannelProtocolVersion = z.literal(BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION)
const Base64Chunk = z
  .string()
  .max(Math.ceil(BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES / 3) * 4)
  .refine(
    (value) => value.length % 4 !== 1 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
    'File channel chunk must be base64'
  )

// Why: Buffer.from tolerates malformed base64 by dropping bytes, which would silently corrupt a staged file.
export function decodeBrowserClientFileChannelChunk(contentBase64: string): Buffer {
  const decoded = Buffer.from(contentBase64, 'base64')
  if (decoded.toString('base64').replace(/=+$/, '') !== contentBase64.replace(/=+$/, '')) {
    throw new Error('browser_client_file_channel_chunk_invalid')
  }
  return decoded
}

const FileChannelPageAuthority = z.object({
  fileChannelProtocolVersion: FileChannelProtocolVersion,
  authorityRuntimeId: Identity,
  authorityEpoch: Identity,
  browserHostClientId: Identity,
  browserHostGeneration: Generation,
  browserPageId: Identity,
  pageHostGeneration: Generation
})

export const BrowserClientFileChannelReadParams = FileChannelPageAuthority.extend({
  // Why: workspace-relative paths are containment-checked; an absolute one must be named by the host's own upload command.
  workspaceRelativePath: z.string().min(1).max(4096),
  offset: z.number().int().nonnegative().max(BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES),
  length: z.number().int().positive().max(BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES)
})

export type BrowserClientFileChannelReadParams = z.infer<typeof BrowserClientFileChannelReadParams>

export const BrowserClientFileChannelReadResult = z.object({
  contentBase64: Base64Chunk,
  bytesRead: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  eof: z.boolean()
})

export type BrowserClientFileChannelReadResult = z.infer<typeof BrowserClientFileChannelReadResult>

export const BrowserClientFileChannelWriteParams = FileChannelPageAuthority.extend({
  transferId: Identity,
  filename: z.string().min(1).max(255),
  contentBase64: Base64Chunk,
  offset: z.number().int().nonnegative().max(BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES),
  final: z.boolean()
})

export type BrowserClientFileChannelWriteParams = z.infer<
  typeof BrowserClientFileChannelWriteParams
>

export const BrowserClientFileChannelWriteResult = z.object({
  accepted: z.literal(true),
  // Why: only the final chunk knows the committed destination, so earlier acks carry no path.
  workspaceRelativePath: z.string().max(4096).optional()
})

export type BrowserClientFileChannelWriteResult = z.infer<
  typeof BrowserClientFileChannelWriteResult
>

/** Sent as a download starts, so this host binds it to what started it before any byte arrives.
 *  Servers without it answer method_not_found and the download takes the ordinary path. */
export const BrowserClientFileChannelBeginParams = FileChannelPageAuthority.extend({
  transferId: Identity,
  filename: z.string().min(1).max(255),
  /** The address of the page that started the download, as the desktop's browser has it. */
  documentUrl: z.string().max(8192),
  /** An agent's path-free `download` on this page asked for it; only the host sends those. */
  agentDownload: z.literal(true).optional()
})

export type BrowserClientFileChannelBeginParams = z.infer<
  typeof BrowserClientFileChannelBeginParams
>

export const BrowserClientFileChannelAbortParams = FileChannelPageAuthority.extend({
  transferId: Identity
})
