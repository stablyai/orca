import { createMarkdownFenceTracker } from '../../../../../../shared/markdown/markdown-fence-scanner'

export const FOOTNOTE_IDENTIFIER_MAX_LENGTH = 256

const WHITESPACE_OR_BRACKET_PATTERN = /[\s[\]]/
const DEFINITION_OPENING_PATTERN =
  /^ {0,3}\[\^([^\s[\]]+)\]:(?:([ \t]+([^\r\n]*))|[ \t]*)(?:\r?\n|$)/
const BLOCKQUOTE_PREFIX_PATTERN = /^ {0,3}(?:> ?)+/
const BLOCK_INTERRUPT_PATTERN =
  /^ {0,3}(?:\[\^[^\s[\]]+\]:|#{1,6}(?:[ \t]|$)|>|(?:`{3,}|~{3,})|(?:[-*_][ \t]*){3,}$|(?:[-+*]|\d{1,9}[.)])[ \t]+)/

export type FootnoteDefinitionOpening = {
  identifier: string
  firstLineContent: string
  labelPrefixEnd: number
  lineEnd: number
  nextLineStart: number
}

export type FootnoteDefinitionBlockMatch = {
  raw: string
  identifier: string
  body: string
}

export type FootnoteReferenceMatch = {
  end: number
  identifier: string
}

export function isValidFootnoteIdentifier(identifier: string): boolean {
  if (
    identifier.length === 0 ||
    identifier.length > FOOTNOTE_IDENTIFIER_MAX_LENGTH ||
    WHITESPACE_OR_BRACKET_PATTERN.test(identifier)
  ) {
    return false
  }
  for (let i = 0; i < identifier.length; i += 1) {
    const code = identifier.charCodeAt(i)
    if (code <= 31 || code === 127) {
      return false
    }
  }
  return true
}

export function normalizeFootnoteIdentifier(identifier: string): string {
  return identifier.toLowerCase()
}

function getLineEnd(content: string, start: number): { lineEnd: number; nextLineStart: number } {
  const newlineIndex = content.indexOf('\n', start)
  const rawEnd = newlineIndex === -1 ? content.length : newlineIndex
  const lineEnd = rawEnd > start && content.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd
  return { lineEnd, nextLineStart: newlineIndex === -1 ? content.length : newlineIndex + 1 }
}

export function matchFootnoteDefinitionOpening(
  content: string,
  start: number
): FootnoteDefinitionOpening | null {
  if (start > 0 && content[start - 1] !== '\n') {
    return null
  }
  const { lineEnd, nextLineStart } = getLineEnd(content, start)
  const line = content.slice(start, lineEnd)
  const match = DEFINITION_OPENING_PATTERN.exec(line)
  if (!match || !isValidFootnoteIdentifier(match[1])) {
    return null
  }
  const colonIndex = line.indexOf(']:')
  if (colonIndex === -1) {
    return null
  }
  return {
    identifier: match[1],
    firstLineContent: match[3] ?? '',
    labelPrefixEnd: start + colonIndex + 2,
    lineEnd,
    nextLineStart
  }
}

export function isFootnoteDefinitionLine(line: string): boolean {
  const match = DEFINITION_OPENING_PATTERN.exec(line)
  return Boolean(match && isValidFootnoteIdentifier(match[1]))
}

export function matchFootnoteDefinitionLinePrefix(content: string, start: number): number | null {
  if (start > 0 && content[start - 1] !== '\n') {
    return null
  }
  const { lineEnd } = getLineEnd(content, start)
  const line = content.slice(start, lineEnd)
  const quotePrefixLength = BLOCKQUOTE_PREFIX_PATTERN.exec(line)?.[0].length ?? 0
  const remainder = line.slice(quotePrefixLength)
  const match = DEFINITION_OPENING_PATTERN.exec(remainder)
  if (!match || !isValidFootnoteIdentifier(match[1])) {
    return null
  }
  const colonIndex = remainder.indexOf(']:')
  return colonIndex === -1 ? null : start + quotePrefixLength + colonIndex + 2
}

function stripOneIndentLevel(line: string): string | null {
  let columns = 0
  let index = 0
  while (index < line.length && columns < 4) {
    const ch = line[index]
    if (ch === ' ') {
      columns += 1
      index += 1
    } else if (ch === '\t') {
      columns = 4
      index += 1
    } else {
      break
    }
  }
  if (columns < 4) {
    return null
  }
  return line.slice(index)
}

function isBlankLine(line: string): boolean {
  return /^[ \t]*$/.test(line)
}

export function matchFootnoteDefinitionBlock(
  source: string,
  start = 0
): FootnoteDefinitionBlockMatch | null {
  const opening = matchFootnoteDefinitionOpening(source, start)
  if (!opening) {
    return null
  }

  const bodyLines: string[] = []
  const bodyFence = createMarkdownFenceTracker()
  let hasContentOnOpening = false
  if (opening.firstLineContent.length > 0) {
    bodyLines.push(opening.firstLineContent)
    bodyFence.consume(opening.firstLineContent)
    hasContentOnOpening = true
  }

  let cursor = opening.nextLineStart
  let lastConsumedEnd = opening.nextLineStart
  let pendingBlankLines: string[] = []
  let canLazyContinue =
    hasContentOnOpening &&
    !bodyFence.insideFence &&
    !BLOCK_INTERRUPT_PATTERN.test(opening.firstLineContent)

  while (cursor < source.length) {
    const lineBreakIndex = source.indexOf('\n', cursor)
    const rawLineEnd = lineBreakIndex === -1 ? source.length : lineBreakIndex
    const hasCr = rawLineEnd > cursor && source.charCodeAt(rawLineEnd - 1) === 13
    const lineEnd = hasCr ? rawLineEnd - 1 : rawLineEnd
    const nextCursor = lineBreakIndex === -1 ? source.length : lineBreakIndex + 1
    const line = source.slice(cursor, lineEnd)

    if (isBlankLine(line)) {
      pendingBlankLines.push('')
      cursor = nextCursor
      continue
    }

    const stripped = stripOneIndentLevel(line)
    if (stripped !== null) {
      if (bodyLines.length > 0 && pendingBlankLines.length > 0) {
        bodyLines.push(...pendingBlankLines)
      }
      pendingBlankLines = []
      bodyLines.push(stripped)
      const isFenceLine = bodyFence.consume(stripped)
      canLazyContinue =
        !isFenceLine && !bodyFence.insideFence && !BLOCK_INTERRUPT_PATTERN.test(stripped)
      lastConsumedEnd = nextCursor
      cursor = nextCursor
      continue
    }

    if (pendingBlankLines.length === 0 && canLazyContinue && !BLOCK_INTERRUPT_PATTERN.test(line)) {
      bodyLines.push(line)
      lastConsumedEnd = nextCursor
      cursor = nextCursor
      continue
    }

    break
  }

  return {
    raw: source.slice(start, lastConsumedEnd),
    identifier: opening.identifier,
    body: bodyLines.join('\n')
  }
}

export function collectDefinedFootnoteIdentifiers(content: string): Set<string> {
  const identifiers = new Set<string>()
  if (!content.includes('[^')) {
    return identifiers
  }
  const fence = createMarkdownFenceTracker()
  let quoteFence = createMarkdownFenceTracker()
  let lineStart = 0
  while (lineStart <= content.length) {
    const { lineEnd, nextLineStart } = getLineEnd(content, lineStart)
    const line = content.slice(lineStart, lineEnd)
    if (!fence.consume(line) && !fence.insideFence) {
      const quoteMatch = BLOCKQUOTE_PREFIX_PATTERN.exec(line)
      const unwrapped = quoteMatch ? line.slice(quoteMatch[0].length) : line
      if (!quoteMatch && quoteFence.insideFence) {
        quoteFence = createMarkdownFenceTracker()
      }
      const blockedByQuoteFence = quoteMatch
        ? quoteFence.consume(unwrapped) || quoteFence.insideFence
        : false
      if (!blockedByQuoteFence) {
        const match = DEFINITION_OPENING_PATTERN.exec(unwrapped)
        if (match && isValidFootnoteIdentifier(match[1])) {
          identifiers.add(normalizeFootnoteIdentifier(match[1]))
        }
      }
    }
    if (nextLineStart <= lineStart || lineEnd === content.length) {
      break
    }
    lineStart = nextLineStart
  }
  return identifiers
}

export function collectFootnoteDefinitionIdentifiersInOrder(contentWithoutCode: string): string[] {
  const identifiers: string[] = []
  if (!contentWithoutCode.includes('[^')) {
    return identifiers
  }
  let lineStart = 0
  while (lineStart <= contentWithoutCode.length) {
    const { lineEnd, nextLineStart } = getLineEnd(contentWithoutCode, lineStart)
    const unwrapped = contentWithoutCode
      .slice(lineStart, lineEnd)
      .replace(BLOCKQUOTE_PREFIX_PATTERN, '')
    const match = DEFINITION_OPENING_PATTERN.exec(unwrapped)
    if (match && isValidFootnoteIdentifier(match[1])) {
      identifiers.push(match[1])
    }
    if (nextLineStart <= lineStart || lineEnd === contentWithoutCode.length) {
      break
    }
    lineStart = nextLineStart
  }
  return identifiers
}

export function matchFootnoteReferenceSource(
  content: string,
  start: number,
  definedIdentifiers: ReadonlySet<string>
): FootnoteReferenceMatch | null {
  if (
    definedIdentifiers.size === 0 ||
    content.charCodeAt(start) !== 91 ||
    content.charCodeAt(start + 1) !== 94
  ) {
    return null
  }
  const limit = Math.min(content.length, start + 2 + FOOTNOTE_IDENTIFIER_MAX_LENGTH + 1)
  let index = start + 2
  while (index < limit) {
    const code = content.charCodeAt(index)
    if (code === 93) {
      break
    }
    if (code === 91 || code <= 32 || code === 127) {
      return null
    }
    index += 1
  }
  if (index === start + 2 || index >= limit || content.charCodeAt(index) !== 93) {
    return null
  }
  // `[^label](url)` is a standard inline link whose label starts with `^`, not a footnote reference.
  if (content.charCodeAt(index + 1) === 40) {
    return null
  }
  const identifier = content.slice(start + 2, index)
  if (
    !isValidFootnoteIdentifier(identifier) ||
    !definedIdentifiers.has(normalizeFootnoteIdentifier(identifier))
  ) {
    return null
  }
  return { end: index + 1, identifier }
}

const FIRST_LINE_REQUIRES_NEWLINE_PATTERN =
  /^(?:`{3,}|~{3,}|#{1,6}(?:[ \t]|$)|\||>|(?:[-+*]|\d{1,9}[.)])[ \t]+|(?:[-*_][ \t]*){3,}$|<details\b)/i

export function formatFootnoteDefinitionMarkdown(identifier: string, bodyMarkdown: string): string {
  const trimmed = bodyMarkdown.replace(/\n+$/, '')
  if (!trimmed) {
    return `[^${identifier}]:`
  }
  const lines = trimmed.split('\n')
  if (FIRST_LINE_REQUIRES_NEWLINE_PATTERN.test(lines[0])) {
    const indented = lines.map((line) => (line ? `    ${line}` : '')).join('\n')
    return `[^${identifier}]:\n${indented}`
  }
  if (lines.length === 1) {
    return `[^${identifier}]: ${lines[0]}`
  }
  const continuation = lines
    .slice(1)
    .map((line) => (line ? `    ${line}` : ''))
    .join('\n')
  return `[^${identifier}]: ${lines[0]}\n${continuation}`
}
