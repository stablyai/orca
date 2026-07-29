import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from './terminal-bracketed-paste'
import { TERMINAL_PASTE_CHUNK_MAX_BYTES } from './terminal-paste-limits'
import type { TerminalPastePlan } from './terminal-paste-coordinator'

const TERMINAL_PASTE_ESCAPE_CODE_POINT = 0x1b
const TERMINAL_PASTE_INERT_ESCAPE_CODE_POINT = 0x241b
const TERMINAL_PASTE_INERT_ESCAPE = '\u241b'
const LINE_FEED_CODE_POINT = 0x0a
const CARRIAGE_RETURN_CODE_POINT = 0x0d

export function chunkTerminalPastePlan(plan: TerminalPastePlan): string[] {
  return [...iterateTerminalPastePlanChunks(plan)]
}

export function* iterateTerminalPastePlanChunks(plan: TerminalPastePlan): Generator<string> {
  const maxChunkBytes = Math.max(4, plan.maxChunkBytes ?? TERMINAL_PASTE_CHUNK_MAX_BYTES)
  if (plan.bracketed) {
    yield BRACKETED_PASTE_START
  }
  yield* iterateTextByUtf8Bytes(
    plan.payload.plainText,
    maxChunkBytes,
    plan.bracketed,
    plan.newlinePolicy === 'terminal-cr'
  )
  if (plan.bracketed) {
    yield BRACKETED_PASTE_END
  }
}

function* iterateTextByUtf8Bytes(
  text: string,
  maxBytes: number,
  sanitizeEscapes: boolean,
  normalizeLineEndings: boolean
): Generator<string> {
  let chunk = ''
  let chunkBytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index) ?? 0
    const codeUnitLength = codePoint > 0xffff ? 2 : 1
    // Why: iterator normalization avoids a full-size copy and keeps CRLF atomic across chunks.
    if (
      normalizeLineEndings &&
      codePoint === LINE_FEED_CODE_POINT &&
      index > 0 &&
      text.charCodeAt(index - 1) === CARRIAGE_RETURN_CODE_POINT
    ) {
      continue
    }
    const normalizedCodePoint =
      normalizeLineEndings && codePoint === LINE_FEED_CODE_POINT
        ? CARRIAGE_RETURN_CODE_POINT
        : codePoint
    const sanitizedEscape = sanitizeEscapes && codePoint === TERMINAL_PASTE_ESCAPE_CODE_POINT
    const next = sanitizedEscape
      ? TERMINAL_PASTE_INERT_ESCAPE
      : normalizedCodePoint === codePoint
        ? text.slice(index, index + codeUnitLength)
        : '\r'
    const nextBytes = utf8BytesForCodePoint(
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

function utf8BytesForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1
  }
  if (codePoint <= 0x7ff) {
    return 2
  }
  if (codePoint <= 0xffff) {
    return 3
  }
  return 4
}
