import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { routeNativeChatHref } from './native-chat-href-routing'
import { parseExplicitFileLinkTarget } from './explicit-file-link-target'
import { detectTerminalFileUriLinks } from './terminal-file-uri-link'
import type { ParsedTerminalFileLink } from './terminal-links'

const MAX_DESTINATION_LENGTH = 2048
const ESCAPABLE_PUNCTUATION = /^[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]$/
const MARKDOWN_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g
const NON_ESCAPE_BACKSLASH = /\\(?![!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/

type MarkdownDestination = { start: number; end: number; closingIndex: number }

function skipWhitespace(text: string, index: number, limit: number): number {
  while (index < limit && /\s/.test(text[index])) {
    index += 1
  }
  return index
}

function findClosingIndex(text: string, index: number, limit: number): number | null {
  const afterWhitespace = skipWhitespace(text, index, limit)
  if (text[afterWhitespace] === ')') {
    return afterWhitespace
  }
  const quote = text[afterWhitespace]
  if (afterWhitespace === index || (quote !== '"' && quote !== "'" && quote !== '(')) {
    return null
  }
  const closeQuote = quote === '(' ? ')' : quote
  let cursor = afterWhitespace + 1
  while (cursor < limit) {
    if (text[cursor] === '\\' && ESCAPABLE_PUNCTUATION.test(text[cursor + 1] ?? '')) {
      cursor += 2
      continue
    }
    if (text[cursor] === closeQuote) {
      const closing = skipWhitespace(text, cursor + 1, limit)
      return text[closing] === ')' ? closing : null
    }
    cursor += 1
  }
  return null
}

function readDestination(text: string, openingIndex: number): MarkdownDestination | null {
  const limit = Math.min(text.length, openingIndex + MAX_DESTINATION_LENGTH + 1)
  let start = skipWhitespace(text, openingIndex + 1, limit)
  const angle = text[start] === '<'
  if (angle) {
    start += 1
  }
  let depth = 0
  for (let cursor = start; cursor < limit; cursor += 1) {
    const char = text[cursor]
    if (char === '\\' && ESCAPABLE_PUNCTUATION.test(text[cursor + 1] ?? '')) {
      cursor += 1
      continue
    }
    if (char === '\n' || char === '\r' || char === '<') {
      return null
    }
    if (angle ? char === '>' : depth === 0 && (char === ')' || /\s/.test(char))) {
      const closingIndex = findClosingIndex(text, angle ? cursor + 1 : cursor, limit)
      return closingIndex !== null && cursor > start ? { start, end: cursor, closingIndex } : null
    }
    if (!angle) {
      if (char === '(') {
        depth += 1
      }
      if (char === ')') {
        depth -= 1
      }
    }
  }
  return null
}

// Why: Windows destinations use backslash as a separator, so `C:\me\.config` is not an escape.
function unescapeMarkdownDestination(destination: string): string {
  if (
    isWindowsAbsolutePathLike(destination) ||
    !destination.includes('/') ||
    NON_ESCAPE_BACKSLASH.test(destination)
  ) {
    return destination
  }
  return destination.replace(MARKDOWN_ESCAPE, '$1')
}

function toMarkdownFileLink(
  text: string,
  destination: MarkdownDestination
): ParsedTerminalFileLink | null {
  const displayText = text.slice(destination.start, destination.end)
  const href = unescapeMarkdownDestination(displayText)
  if (/^file:/i.test(href)) {
    const link = detectTerminalFileUriLinks(href).find(
      (candidate) => candidate.startIndex === 0 && candidate.endIndex === href.length
    )
    return link
      ? { ...link, startIndex: destination.start, endIndex: destination.end, displayText }
      : null
  }
  const route = routeNativeChatHref(href)
  if (route.kind !== 'file') {
    return null
  }
  const target = parseExplicitFileLinkTarget(route.pathText, { allowRelativeDirectoryPath: true })
  if (!target) {
    return null
  }
  return {
    ...target,
    line: target.line ?? route.line,
    startIndex: destination.start,
    endIndex: destination.end,
    displayText
  }
}

export function detectTerminalMarkdownFileLinks(text: string): {
  links: ParsedTerminalFileLink[]
  remainingText: string
} {
  const links: ParsedTerminalFileLink[] = []
  if (!text.includes('](')) {
    return { links, remainingText: text }
  }
  const openings: number[] = []
  const parts: string[] = []
  let unclaimedStart = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\' && ESCAPABLE_PUNCTUATION.test(text[index + 1] ?? '')) {
      index += 1
      continue
    }
    if (char === '[') {
      openings.push(index)
    }
    if (char !== ']') {
      continue
    }
    const opening = openings.pop()
    if (opening === undefined || text[index + 1] !== '(' || /[\\/]/.test(text[opening - 1] ?? '')) {
      continue
    }
    const destination = readDestination(text, index + 1)
    if (!destination) {
      continue
    }
    const link = toMarkdownFileLink(text, destination)
    if (link) {
      links.push(link)
    }
    // Keep offsets while preventing path-like labels and syntax from becoming other file targets.
    parts.push(
      text.slice(unclaimedStart, opening),
      ' '.repeat(destination.closingIndex + 1 - opening)
    )
    unclaimedStart = destination.closingIndex + 1
    index = destination.closingIndex
    openings.length = 0
  }
  parts.push(text.slice(unclaimedStart))
  return { links, remainingText: parts.join('') }
}
