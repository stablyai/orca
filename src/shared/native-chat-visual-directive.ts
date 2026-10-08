// The one grammar for a native-chat visual: an assistant reply line naming an HTML file in that
// chat's visuals folder. Desktop/web (a markdown syntax extension) and mobile both parse with it.
//
//   ::orca-visual{file="usage-chart-3f2a.html" title="Usage by day"}
//
// - The line may carry up to 3 leading spaces and any trailing spaces/tabs; a trailing CR is
//   ignored. Nothing else may share the line.
// - Attributes are `key="value"`, separated by spaces/tabs. Values have no escapes: they cannot
//   contain `"`, `\`, or control characters. Keys are lowercase ASCII letters.
// - `file` is required. `title` is optional. A repeated key refuses the line. Other keys are
//   ignored, so a newer agent's extra attribute still renders on this viewer.
// - The name is case-sensitive.

export const NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER = '::orca-visual{'

/** Longest line the grammar considers. Bounds parsing and the streaming-tail check. */
export const NATIVE_CHAT_VISUAL_DIRECTIVE_MAX_LINE_LENGTH = 512
export const NATIVE_CHAT_VISUAL_FILE_MAX_LENGTH = 128
export const NATIVE_CHAT_VISUAL_TITLE_MAX_LENGTH = 120

/**
 * Directives one reply may mount; later ones show as text. Each visual runs author script in its
 * own frame (lazily mounted, at most 512 KiB), so this bounds one reply's live frames and memory
 * while leaving room for a reply that compares a few charts.
 */
export const NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE = 8

/** Largest visual file, in UTF-8 bytes. The execution host enforces it in a bounded read. */
export const NATIVE_CHAT_VISUAL_MAX_BYTES = 512 * 1024

export type NativeChatVisualDirective = {
  file: string
  title: string | null
}

const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/
// Why: Windows maps these base names to devices whatever the extension.
const WINDOWS_DEVICE_BASE_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i
const ATTRIBUTE_PATTERN = /^([a-z]+)="([^"]*)"/
const LINE_SPACE = /^[ \t]*/

/**
 * A single file name inside the chat's visuals folder: no directories, separators, `..`, drive,
 * UNC, device or stream forms, ending in `.html`.
 */
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

/**
 * Whether the final, still-growing line of a streaming reply may yet become a directive, so the
 * viewer holds it back instead of flashing raw syntax. A complete-looking line counts too: the
 * agent may still append to it. Only a streaming tail may be held; a finished reply shows it.
 */
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

/**
 * Reply text for plain-text surfaces (a sidebar row, a notification, a copy): the visual lines are
 * dropped, since only the transcript can show them. Lines inside fenced code stay, as the transcript
 * shows them too, and everything else keeps its spacing and indentation.
 */
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
