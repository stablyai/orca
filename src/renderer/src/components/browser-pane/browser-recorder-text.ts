// ---------------------------------------------------------------------------
// Browser action recorder — markdown/text primitives shared by the formatters
// ---------------------------------------------------------------------------

// Why: log text comes from page DOM; avoid spreading every backtick run into
// Math.max when generated markdown contains many fence characters.
function maxBacktickRunLength(content: string, floor: number): number {
  let maxRun = floor
  let currentRun = 0

  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 96) {
      currentRun = 0
      continue
    }

    currentRun += 1
    if (currentRun > maxRun) {
      maxRun = currentRun
    }
  }
  return maxRun
}

export function inlineCode(content: string): string {
  const maxRun = maxBacktickRunLength(content, 0)
  const marker = '`'.repeat(maxRun + 1)
  const padding = content.startsWith('`') || content.endsWith('`') ? ' ' : ''
  return `${marker}${padding}${content}${padding}${marker}`
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatPageUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname}${parsed.search}`
  } catch {
    return url || 'blank page'
  }
}

export const BROWSER_RECORDER_INLINE_TEXT_MAX_LENGTH = 2048

export function inlineText(
  content: string,
  maxLength = BROWSER_RECORDER_INLINE_TEXT_MAX_LENGTH
): string {
  // Why: page-controlled DOM text can include paste-sized content; collapse
  // whitespace while scanning only the bounded text we will actually retain.
  let normalized = ''
  let pendingSpace = false
  for (let index = 0; index < content.length && normalized.length < maxLength; ) {
    const code = content.charCodeAt(index)
    if (isInlineWhitespaceCode(code)) {
      if (code === 13 && content.charCodeAt(index + 1) === 10) {
        index += 1
      }
      pendingSpace = normalized.length > 0
      index += 1
      continue
    }

    const codePoint = content.codePointAt(index)
    if (codePoint === undefined) {
      break
    }
    const char = String.fromCodePoint(codePoint)
    const extraSpaceLength = pendingSpace ? 1 : 0
    if (normalized.length + extraSpaceLength + char.length > maxLength) {
      break
    }
    if (pendingSpace) {
      normalized += ' '
      pendingSpace = false
    }
    normalized += char
    index += char.length
  }
  return normalized
}

function isInlineWhitespaceCode(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}
