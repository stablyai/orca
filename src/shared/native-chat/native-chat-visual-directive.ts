// Shared desktop/web/mobile visual grammar: ::orca-visual{file="chart.html" title="Usage"}. Must occupy a whole case-sensitive line,
// with up to three leading spaces/trailing horizontal whitespace or CR. Attributes use lowercase keys and unescaped quoted values
// (no quote/backslash/control characters). file is required; title optional; reject duplicate keys, ignore unknown keys for newer agents.

export const NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER = '::orca-visual{'

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

/** The directive a whole line spells, or null when the line is anything else. */
export function parseNativeChatVisualDirectiveLine(
  rawLine: string
): NativeChatVisualDirective | null {
  const line = stripLineEnding(rawLine)
  if (line.length > NATIVE_CHAT_VISUAL_DIRECTIVE_MAX_LINE_LENGTH || /[\r\n]/.test(line)) {
    return null
  }
  const indent = leadingSpaceCount(line)
  if (indent > 3 || !line.startsWith(NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER, indent)) {
    return null
  }
  const trimmedEnd = line.replace(/[ \t]+$/, '')
  if (!trimmedEnd.endsWith('}')) {
    return null
  }
  const body = trimmedEnd.slice(indent + NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER.length, -1)
  const attributes = parseAttributes(body)
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
  if (rest.length <= NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER.length) {
    return NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER.startsWith(rest)
  }
  return rest.startsWith(NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER) && !/[\r\n]/.test(rest)
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

/** Remove visual directives for plain-text previews/copy/notifications. Preserve fenced code and surrounding indentation/spacing. */
export function withoutNativeChatVisualDirectiveLines(text: string): string {
  if (!text.includes(NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER)) {
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
    if (fence) {
      const closer = FENCE_CLOSE.exec(bare)?.[1]
      if (closer && closer[0] === fence[0] && closer.length >= fence.length) {
        fence = null
      }
      kept.push(line)
      continue
    }
    const opener = FENCE_OPEN.exec(bare)?.[1]
    if (opener) {
      fence = opener
      kept.push(line)
      continue
    }
    if (parseNativeChatVisualDirectiveLine(line)) {
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
