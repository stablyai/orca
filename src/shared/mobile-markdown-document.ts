import { getClipboardTextByteLength, isClipboardTextByteLengthOverLimit } from './clipboard-text'
import { clampUtf8TextPrefix } from './utf8-byte-limits'

export const MOBILE_MARKDOWN_EDIT_MAX_BYTES = 256 * 1024
/** Markdown preview budget; the file preview keeps its own. Above it a mobile read returns a
 *  UTF-8-boundary prefix marked `truncated`, never a refusal. Sized like the 2 MiB terminal
 *  snapshot; the relay splice frame cap is 8 MiB. */
export const MOBILE_MARKDOWN_READ_MAX_BYTES = 2 * 1024 * 1024

export type RuntimeMarkdownReadOnlyReason =
  | 'unsupported_preview'
  | 'unsupported_tab'
  | 'unsupported_untitled'
  | 'file_too_large'

export type RuntimeMobileMarkdownRequest =
  | {
      id: string
      operation: 'read'
      worktreeId: string
      tabId: string
    }
  | {
      id: string
      operation: 'save'
      worktreeId: string
      tabId: string
      baseVersion: string
      content: string
    }

export type RuntimeMobileMarkdownResponse =
  | {
      id: string
      ok: true
      result: RuntimeMarkdownReadTabResult | RuntimeMarkdownSaveTabResult
    }
  | {
      id: string
      ok: false
      error: string
    }

export type RuntimeMarkdownReadTabResult = {
  tabId: string
  filePath: string
  relativePath: string
  content: string
  isDirty: boolean
  version: string
  source: 'draft' | 'file'
  editable: boolean
  readOnlyReason?: RuntimeMarkdownReadOnlyReason
  /** Present only when `content` is a prefix; older phones ignore both fields. */
  truncated?: boolean
  /** The full document's UTF-8 size, sent with `truncated`. */
  byteLength?: number
}

export type RuntimeMarkdownSaveTabResult = {
  tabId: string
  version: string
  isDirty: false
  content: string
}

export function hashMarkdownContent(content: string): string {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < content.length; i += 1) {
    hash ^= BigInt(content.charCodeAt(i))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `content:${utf8ByteLength(content)}:${hash.toString(16).padStart(16, '0')}`
}

export function isMarkdownContentByteLengthOverLimit(content: string, maxBytes: number): boolean {
  return isClipboardTextByteLengthOverLimit(content, maxBytes)
}

export function utf8ByteLength(content: string): number {
  return getClipboardTextByteLength(content)
}

export function truncateMobileMarkdownRead(
  content: string
):
  | { content: string; truncated: false }
  | { content: string; truncated: true; byteLength: number } {
  const byteLength = utf8ByteLength(content)
  if (byteLength <= MOBILE_MARKDOWN_READ_MAX_BYTES) {
    return { content, truncated: false }
  }
  return {
    content: clampUtf8TextPrefix(content, MOBILE_MARKDOWN_READ_MAX_BYTES),
    truncated: true,
    byteLength
  }
}
