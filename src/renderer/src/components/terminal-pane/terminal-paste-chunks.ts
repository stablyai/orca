import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from './terminal-bracketed-paste'
import { TERMINAL_PASTE_CHUNK_MAX_BYTES } from './terminal-paste-limits'
import type { TerminalPastePlan } from './terminal-paste-coordinator'
import {
  getUtf8ByteLengthForCodePoint,
  readUtf8CodePointAt
} from '../../../../shared/utf8-byte-limits'

const TERMINAL_PASTE_ESCAPE_CODE_POINT = 0x1b
const TERMINAL_PASTE_INERT_ESCAPE_CODE_POINT = 0x241b
const TERMINAL_PASTE_INERT_ESCAPE = '\u241b'
const LINE_FEED_CODE_POINT = 0x0a
const CARRIAGE_RETURN_CODE_POINT = 0x0d

export function chunkTerminalPastePlan(plan: TerminalPastePlan): string[] {
  return [...iterateTerminalPastePlanChunks(plan)]
}

export function* iterateTerminalPastePlanChunks(plan: TerminalPastePlan): Generator<string> {
  const maxChunkBytes = Math.max(
    plan.windowsInputRecordNewline === 'csi-u' ? 8 : 4,
    plan.maxChunkBytes ?? TERMINAL_PASTE_CHUNK_MAX_BYTES
  )
  if (plan.bracketed) {
    yield BRACKETED_PASTE_START
  }
  yield* iterateTextByUtf8Bytes(
    plan.payload.plainText,
    maxChunkBytes,
    plan.bracketed || plan.newlinePolicy === 'windows-input-record',
    plan.newlinePolicy,
    plan.windowsInputRecordNewline
  )
  if (plan.bracketed) {
    yield BRACKETED_PASTE_END
  }
}

function* iterateTextByUtf8Bytes(
  text: string,
  maxBytes: number,
  sanitizeEscapes: boolean,
  newlinePolicy: TerminalPastePlan['newlinePolicy'],
  windowsInputRecordNewline?: TerminalPastePlan['windowsInputRecordNewline']
): Generator<string> {
  let chunk = ''
  let chunkBytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = readUtf8CodePointAt(text, index)
    const codeUnitLength = codePoint > 0xffff ? 2 : 1
    // Why: iterator normalization avoids a full-size copy and keeps CRLF atomic across chunks.
    if (
      newlinePolicy !== 'preserve' &&
      codePoint === LINE_FEED_CODE_POINT &&
      index > 0 &&
      text.charCodeAt(index - 1) === CARRIAGE_RETURN_CODE_POINT
    ) {
      continue
    }
    const isLineEnding =
      newlinePolicy !== 'preserve' &&
      (codePoint === LINE_FEED_CODE_POINT || codePoint === CARRIAGE_RETURN_CODE_POINT)
    const normalizedCodePoint = isLineEnding ? CARRIAGE_RETURN_CODE_POINT : codePoint
    const sanitizedEscape = sanitizeEscapes && codePoint === TERMINAL_PASTE_ESCAPE_CODE_POINT
    const next =
      isLineEnding && newlinePolicy === 'windows-input-record'
        ? windowsInputRecordNewline === 'csi-u'
          ? '\x1b[13;2u'
          : '\x1b\r'
        : sanitizedEscape
          ? TERMINAL_PASTE_INERT_ESCAPE
          : normalizedCodePoint === codePoint
            ? text.slice(index, index + codeUnitLength)
            : '\r'
    const nextBytes =
      isLineEnding && newlinePolicy === 'windows-input-record'
        ? next.length
        : getUtf8ByteLengthForCodePoint(
            sanitizedEscape ? TERMINAL_PASTE_INERT_ESCAPE_CODE_POINT : normalizedCodePoint
          )
    if (chunk && chunkBytes + nextBytes > maxBytes) {
      yield chunk
      chunk = next
      chunkBytes = nextBytes
      if (codeUnitLength === 2) {
        index += 1
      }
      continue
    }
    chunk += next
    chunkBytes += nextBytes
    if (codeUnitLength === 2) {
      index += 1
    }
  }
  if (chunk) {
    yield chunk
  }
}
