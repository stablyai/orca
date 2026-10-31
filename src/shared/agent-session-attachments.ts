// The execution host owns chat attachments; paired clients upload bytes, local pastes write in place, and agents receive only host paths.

import type { ImportSkipReason } from './filesystem-import-result-types'

/** Host userData store name; clients recognize stored paths without a round trip. */
export const AGENT_SESSION_ATTACHMENTS_DIR_NAME = 'agent-session-attachments'

export const AGENT_SESSION_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024

/** 384 KiB of bytes is 512 KiB of base64 on the wire, the same frame size file imports use. */
export const AGENT_SESSION_ATTACHMENT_CHUNK_BYTES = 384 * 1024

export const AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS =
  (AGENT_SESSION_ATTACHMENT_CHUNK_BYTES / 3) * 4

export const AGENT_SESSION_ATTACHMENT_NAME_MAX_BYTES = 200

/** Bytes a padded base64 string decodes to, without decoding it. */
export function base64DecodedByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length / 4) * 3 - padding
}

/** Append whole base64 groups at byte offsets; even empty files require an empty append before commit. */
export function* agentSessionAttachmentAppends(
  contentBase64: string
): Generator<{ offset: number; contentBase64: string }> {
  let charOffset = 0
  do {
    yield {
      offset: (charOffset / 4) * 3,
      contentBase64: contentBase64.slice(
        charOffset,
        charOffset + AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS
      )
    }
    charOffset += AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS
  } while (charOffset < contentBase64.length)
}

export type AgentSessionAttachmentUploadStartResult = { uploadId: string }
export type AgentSessionAttachmentUploadCommitResult = {
  path: string
  name: string
  byteLength: number
}

/** Preview routing only; the host still validates real-path access before reading. */
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

/** Preserve meaningful filenames/extensions while limiting the final path segment to portable UTF-8 byte length and Windows-safe names. */
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

/** Recheck pairing per call and server identity per chunk; re-pairing or server replacement aborts uploads. */
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

/** Save clipboard images into the runtimeEnvironmentId server's chat store rather than its temp directory. */
export type AgentSessionAttachmentClipboardTarget = Omit<
  AgentSessionAttachmentUploadTarget,
  'environmentId'
>

/** `orca-paste-…png`, the name every pasted image gets, so it reads as "Pasted image". */
export function agentSessionPastedImageName(now: number, unique: string): string {
  return `orca-paste-${now}-${unique}.png`
}

/** `orca-paste-…txt`, the name a long text paste saved as a file gets, so it reads as "Pasted text". */
export function agentSessionPastedTextName(now: number, unique: string): string {
  return `orca-paste-${now}-${unique}.txt`
}
