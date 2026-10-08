// Files a client attaches to a structured chat on a paired Orca server: the client uploads the
// bytes, the server keeps them in a store it owns, and the agent only ever sees the server path.

import type { ImportSkipReason } from './filesystem-import-result-types'

/** Directory name of the server's store, under its userData. Also how a client recognizes a
 *  stored attachment's path without a round trip. */
export const AGENT_SESSION_ATTACHMENTS_DIR_NAME = 'agent-session-attachments'

export const AGENT_SESSION_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024

/** 384 KiB of bytes is 512 KiB of base64 on the wire, the same frame size file imports use. */
export const AGENT_SESSION_ATTACHMENT_CHUNK_BYTES = 384 * 1024

export const AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS =
  (AGENT_SESSION_ATTACHMENT_CHUNK_BYTES / 3) * 4

export const AGENT_SESSION_ATTACHMENT_NAME_MAX_BYTES = 200

export type AgentSessionAttachmentUploadStartResult = { uploadId: string }
export type AgentSessionAttachmentUploadCommitResult = {
  path: string
  name: string
  byteLength: number
}

/** Whether `filePath` names a file in some server's attachment store. Only routes a preview read;
 *  the server re-checks the real path before reading anything. */
export function isAgentSessionAttachmentStorePath(filePath: string): boolean {
  return filePath.split(/[\\/]/).includes(AGENT_SESSION_ATTACHMENTS_DIR_NAME)
}

// Windows refuses these as a file's name whatever its extension, and drops trailing dots and spaces.
const WINDOWS_DEVICE_NAME =
  /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/** Whole characters from the start of `text` that fit in `maxBytes` of UTF-8. */
function truncateUtf8(text: string, maxBytes: number): string {
  let kept = ''
  let bytes = 0
  for (const character of text) {
    bytes += utf8ByteLength(character)
    if (bytes > maxBytes) {
      break
    }
    kept += character
  }
  return kept
}

/**
 * A stored file keeps the user's file name, since agents read meaning into names and extensions.
 * Only the last path segment survives, without control characters or separators, short enough in
 * bytes for every server's file system and never a name Windows reserves.
 */
export function sanitizeAgentSessionAttachmentName(name: string): string {
  const leaf = name.split(/[\\/]/).findLast((part) => part.length > 0) ?? ''
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim()
  let visible = cleaned.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (visible.length === 0) {
    return 'attachment'
  }
  const firstDot = visible.indexOf('.')
  if (WINDOWS_DEVICE_NAME.test(firstDot > 0 ? visible.slice(0, firstDot) : visible)) {
    visible = `_${visible}`
  }
  if (utf8ByteLength(visible) <= AGENT_SESSION_ATTACHMENT_NAME_MAX_BYTES) {
    return visible
  }
  const extensionAt = visible.lastIndexOf('.')
  const extension =
    extensionAt > 0 && utf8ByteLength(visible.slice(extensionAt)) <= 16
      ? visible.slice(extensionAt)
      : ''
  const stem = visible.slice(0, visible.length - extension.length)
  const truncated =
    truncateUtf8(stem, AGENT_SESSION_ATTACHMENT_NAME_MAX_BYTES - utf8ByteLength(extension)) +
    extension
  // Cutting can expose a trailing dot or space, which Windows drops from a name.
  return truncated.replace(/[. ]+$/, '') || 'attachment'
}

/** Pins an upload to the server the attachment was meant for: every call re-checks the pairing,
 *  and every chunk the server process, so a re-pair or a replaced server aborts the upload. */
export type AgentSessionAttachmentUploadTarget = {
  environmentId: string
  sessionId: string
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId: string
}

export type AgentSessionAttachmentPathUploadResult = {
  /** Input order; `path` is where the server stored the file. */
  uploaded: { sourcePath: string; path: string }[]
  skipped: { sourcePath: string; reason: ImportSkipReason }[]
  failed: { sourcePath: string; reason: string }[]
}

/** Asks a clipboard image save to land in the chat's attachment store on the paired server named
 *  by the save's `runtimeEnvironmentId`, instead of that server's temp directory. */
export type AgentSessionAttachmentClipboardTarget = Omit<
  AgentSessionAttachmentUploadTarget,
  'environmentId'
>

/** `orca-paste-…png`, the name every pasted image gets, so it reads as "Pasted image". */
export function agentSessionPastedImageName(now: number, unique: string): string {
  return `orca-paste-${now}-${unique}.png`
}
