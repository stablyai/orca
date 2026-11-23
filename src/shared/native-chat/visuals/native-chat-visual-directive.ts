// Shared desktop/web/mobile visual grammar: ::orca-visual{file="chart.html" title="Usage"}. Must occupy a whole case-sensitive line,
// with up to three leading spaces/trailing horizontal whitespace or CR. Attributes use lowercase keys and unescaped quoted values
// (no quote/backslash/control characters). file is required; title optional; reject duplicate keys, ignore unknown keys for newer agents.

import { WEBHOOK_HOOK_ID_PATTERN } from '../../connector-webhook-contract'

export const NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER = '::orca-visual{'
// ::orca-webhook{hook="wh_…"}: the webhook card. Only the hook id is in the line; the card reads the rest from the host.
export const NATIVE_CHAT_WEBHOOK_DIRECTIVE_MARKER = '::orca-webhook{'
const DIRECTIVE_MARKERS = [
  NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER,
  NATIVE_CHAT_WEBHOOK_DIRECTIVE_MARKER
]

/** Longest line the grammar considers. Bounds parsing and the streaming-tail check. */
export const NATIVE_CHAT_VISUAL_DIRECTIVE_MAX_LINE_LENGTH = 512
export const NATIVE_CHAT_VISUAL_FILE_MAX_LENGTH = 128
export const NATIVE_CHAT_VISUAL_TITLE_MAX_LENGTH = 120

/** Cap reply-mounted visuals: each author-script frame can hold 512 KiB, so bound live frames/memory while allowing a few comparisons. */
export const NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE = 8

/** Largest visual file, in UTF-8 bytes. The execution host enforces it in a bounded read. */
export const NATIVE_CHAT_VISUAL_MAX_BYTES = 512 * 1024

export type NativeChatVisualDirective = {
  file: string
  title: string | null
}

export type NativeChatWebhookDirective = { hookId: string }

const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/
// Why: Windows maps these base names to devices whatever the extension.
const WINDOWS_DEVICE_BASE_NAME =
  /^(?:con|prn|aux|nul|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3]|conin\$|conout\$)$/i
const ATTRIBUTE_PATTERN = /^([a-z]+)="([^"]*)"/
const LINE_SPACE = /^[ \t]*/

/** One scratch-folder .html basename; reject directories, traversal, drive/UNC/device/stream forms. */
export function isNativeChatVisualFileName(name: string): boolean {
  if (
    name.length === 0 ||
    name.length > NATIVE_CHAT_VISUAL_FILE_MAX_LENGTH ||
    !FILE_NAME_PATTERN.test(name) ||
    name.includes('..')
  ) {
    return false
  }
  const baseName = name.slice(0, name.indexOf('.'))
  return !WINDOWS_DEVICE_BASE_NAME.test(baseName)
}

function isPlainAttributeValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f || code === 0x5c) {
      return false
    }
  }
  return true
}

function stripLineEnding(line: string): string {
  if (line.endsWith('\r\n')) {
    return line.slice(0, -2)
  }
  return line.endsWith('\n') || line.endsWith('\r') ? line.slice(0, -1) : line
}

function leadingSpaceCount(line: string): number {
  let count = 0
  while (line[count] === ' ') {
    count += 1
  }
  return count
}

function parseAttributes(body: string): Map<string, string> | null {
  const attributes = new Map<string, string>()
  let rest = body.replace(LINE_SPACE, '')
  while (rest.length > 0) {
    const match = ATTRIBUTE_PATTERN.exec(rest)
    if (!match) {
      return null
    }
    const [whole, key, value] = match
    if (attributes.has(key) || !isPlainAttributeValue(value)) {
      return null
    }
    attributes.set(key, value)
    rest = rest.slice(whole.length)
    const separator = LINE_SPACE.exec(rest)?.[0] ?? ''
    if (rest.length > 0 && separator.length === 0) {
      return null
    }
    rest = rest.slice(separator.length)
  }
  return attributes
}

/** A whole directive line's attributes for this marker, or null when the line is anything else. */
function directiveAttributes(rawLine: string, marker: string): Map<string, string> | null {
  const line = stripLineEnding(rawLine)
  if (line.length > NATIVE_CHAT_VISUAL_DIRECTIVE_MAX_LINE_LENGTH || /[\r\n]/.test(line)) {
    return null
  }
  const indent = leadingSpaceCount(line)
  if (indent > 3 || !line.startsWith(marker, indent)) {
    return null
  }
  const trimmedEnd = line.replace(/[ \t]+$/, '')
  if (!trimmedEnd.endsWith('}')) {
    return null
  }
  return parseAttributes(trimmedEnd.slice(indent + marker.length, -1))
}

/** The directive a whole line spells, or null when the line is anything else. */
export function parseNativeChatVisualDirectiveLine(
  rawLine: string
): NativeChatVisualDirective | null {
  const attributes = directiveAttributes(rawLine, NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER)
  const file = attributes?.get('file')
  if (!attributes || file === undefined || !isNativeChatVisualFileName(file)) {
    return null
  }
  const title = attributes.get('title')?.trim() ?? ''
  if (title.length > NATIVE_CHAT_VISUAL_TITLE_MAX_LENGTH) {
    return null
  }
  return { file, title: title.length > 0 ? title : null }
}

/** The webhook card a whole line names, or null when the line is anything else. */
export function parseNativeChatWebhookDirectiveLine(
  rawLine: string
): NativeChatWebhookDirective | null {
  const hookId = directiveAttributes(rawLine, NATIVE_CHAT_WEBHOOK_DIRECTIVE_MARKER)?.get('hook')
  return hookId !== undefined && WEBHOOK_HOOK_ID_PATTERN.test(hookId) ? { hookId } : null
}

function isDirectiveLine(line: string): boolean {
  return (
    parseNativeChatVisualDirectiveLine(line) !== null ||
    parseNativeChatWebhookDirectiveLine(line) !== null
  )
}

/** Hold possible directive tails only while streaming to avoid raw-syntax flashes; even complete-looking tails can grow. Finished replies show them. */
export function isPendingNativeChatVisualDirectiveTail(lastLine: string): boolean {
  const line = stripLineEnding(lastLine)
  if (line.length === 0 || line.length > NATIVE_CHAT_VISUAL_DIRECTIVE_MAX_LINE_LENGTH) {
    return false
  }
  const indent = leadingSpaceCount(line)
  if (indent > 3 || indent === line.length) {
    return false
  }
  const rest = line.slice(indent)
  return DIRECTIVE_MARKERS.some((marker) =>
    rest.length <= marker.length
      ? marker.startsWith(rest)
      : rest.startsWith(marker) && !/[\r\n]/.test(rest)
  )
}

/** Drops a pending directive tail (see above) from streaming reply text. */
export function withoutPendingNativeChatVisualDirectiveTail(text: string): string {
  const lineStart = text.lastIndexOf('\n') + 1
  return isPendingNativeChatVisualDirectiveTail(text.slice(lineStart))
    ? text.slice(0, lineStart)
    : text
}

// CommonMark fences: a backtick opener's info string has no backtick; a closer has no info string.
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/** The fence state after a line, and whether the line is fenced code (its fences included). */
function fenceStep(fence: string | null, bare: string): { fence: string | null; code: boolean } {
  if (fence) {
    const closer = FENCE_CLOSE.exec(bare)?.[1]
    const closes = closer !== undefined && closer[0] === fence[0] && closer.length >= fence.length
    return { fence: closes ? null : fence, code: true }
  }
  const opener = FENCE_OPEN.exec(bare)?.[1]
  return opener ? { fence: opener, code: true } : { fence: null, code: false }
}

// Bots wrote ::orca-idea{text="…"} lines in their first message until 2026-11-09; old transcripts still hold them.
const LEGACY_IDEA_DIRECTIVE_MARKER = '::orca-idea{'

/** Old transcripts' idea lines as plain list lines of their text; fenced code keeps them as written. */
export function withLegacyNativeChatIdeasAsList(text: string): string {
  if (!text.includes(LEGACY_IDEA_DIRECTIVE_MARKER)) {
    return text
  }
  let fence: string | null = null
  return text
    .split('\n')
    .map((line) => {
      const step = fenceStep(fence, line.replace(/\r$/, ''))
      fence = step.fence
      const idea = step.code
        ? undefined
        : directiveAttributes(line, LEGACY_IDEA_DIRECTIVE_MARKER)?.get('text')?.trim()
      return idea ? `- ${idea}` : line
    })
    .join('\n')
}

/** Remove visual and webhook directives for plain-text previews/copy/notifications. Preserve fenced code and surrounding indentation/spacing. */
export function withoutNativeChatVisualDirectiveLines(text: string): string {
  if (!DIRECTIVE_MARKERS.some((marker) => text.includes(marker))) {
    return text
  }
  let fence: string | null = null
  let skipBlank = false
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const bare = line.replace(/\r$/, '')
    const blank = bare.trim().length === 0
    if (skipBlank && blank) {
      // The blank line that separated a removed visual from what follows.
      skipBlank = false
      continue
    }
    skipBlank = false
    const step = fenceStep(fence, bare)
    fence = step.fence
    if (step.code) {
      kept.push(line)
      continue
    }
    if (isDirectiveLine(line)) {
      // Drop one blank neighbour too, so the gap closes; every other line keeps its spacing.
      const previous = kept.at(-1)
      skipBlank = previous === undefined || previous.replace(/\r$/, '').trim().length === 0
      continue
    }
    kept.push(line)
  }
  // Only blank lines the removal left at the very start or end go; indentation is kept.
  return kept
    .join('\n')
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/(?:\r?\n[ \t]*)+$/, '')
    .replace(/\r$/, '')
}
