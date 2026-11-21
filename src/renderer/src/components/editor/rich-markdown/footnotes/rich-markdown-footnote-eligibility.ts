import {
  countBlockquoteDepth,
  stripBlockquoteLevels
} from '../../markdown/source-scanning/markdown-code-and-comment-scan'
import { stripClosedHtmlComments } from '../../markdown/source-scanning/markdown-html-comment-scan'
import {
  extractFootnoteDefinitionIdentifier,
  isFootnoteDefinitionLine,
  matchFootnoteDefinitionBlock,
  matchFootnoteDefinitionLinePrefix,
  matchFootnoteReferenceSource,
  normalizeFootnoteIdentifier
} from './rich-markdown-footnote-source'

export const FOOTNOTE_CANDIDATE_PATTERN = /^ {0,3}(?:> ?)* {0,3}\[\^[^\s[\]]+\]:/m

const FOOTNOTE_CANDIDATE_LINE_PATTERN = /^ {0,3}(?:> ?)* {0,3}\[\^[^\s[\]]+\]:/
const BLOCKQUOTE_PREFIX_PATTERN = /^ {0,3}(?:> ?)+/
const SINGLE_LINE_REFERENCE_LINK_PATTERN = /^ {0,3}\[[^\]]+\]:[ \t]+\S/
const MULTILINE_REFERENCE_LINK_LABEL_PATTERN = /^ {0,3}\[[^\]]+\]:[ \t]*$/
const MULTILINE_REFERENCE_LINK_TARGET_PATTERN = /^ {0,3}\S/
const TRANSPORT_ENVELOPE_PATTERN = /\[\[ORCA_RICH_MD:[a-f0-9]{32}:/
// Cap container nesting depth so crafted repeated footnote/quote prefixes stay linear and stack-safe.
const MAX_REFERENCE_SCAN_DEPTH = 32

export function hasFootnoteCandidate(contentWithoutCode: string): boolean {
  if (!contentWithoutCode.includes('[^')) {
    return false
  }
  return FOOTNOTE_CANDIDATE_PATTERN.test(stripClosedHtmlComments(contentWithoutCode))
}

function getLineBounds(
  content: string,
  lineStart: number
): { lineEnd: number; nextLineStart: number } {
  const newlineIndex = content.indexOf('\n', lineStart)
  const rawEnd = newlineIndex === -1 ? content.length : newlineIndex
  const lineEnd = rawEnd > lineStart && content.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd
  return { lineEnd, nextLineStart: newlineIndex === -1 ? content.length : newlineIndex + 1 }
}

export function hasNonFootnoteReferenceLinkCandidate(contentWithoutCode: string): boolean {
  if (!contentWithoutCode.includes(']:')) {
    return false
  }

  const pending: { content: string; depth: number }[] = [{ content: contentWithoutCode, depth: 0 }]

  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.depth >= MAX_REFERENCE_SCAN_DEPTH) {
      return true
    }
    const text = current.content
    if (!text.includes(']:')) {
      continue
    }

    let lineStart = 0
    while (lineStart <= text.length) {
      const { lineEnd, nextLineStart } = getLineBounds(text, lineStart)
      const line = text.slice(lineStart, lineEnd)
      const quoteMatch = line.match(BLOCKQUOTE_PREFIX_PATTERN)
      if (quoteMatch) {
        const quoteDepth = countBlockquoteDepth(quoteMatch[0])
        const quotedLines: string[] = []
        let scanStart = lineStart
        let chunkEnd = nextLineStart
        while (scanStart <= text.length) {
          const bounds = getLineBounds(text, scanStart)
          const stripped = stripBlockquoteLevels(text.slice(scanStart, bounds.lineEnd), quoteDepth)
          if (stripped === null) {
            break
          }
          quotedLines.push(stripped)
          chunkEnd = bounds.nextLineStart
          if (bounds.lineEnd === text.length) {
            break
          }
          scanStart = bounds.nextLineStart
        }
        pending.push({ content: quotedLines.join('\n'), depth: current.depth + 1 })
        if (chunkEnd <= lineStart || chunkEnd >= text.length) {
          break
        }
        lineStart = chunkEnd
        continue
      }

      if (isFootnoteDefinitionLine(line)) {
        const block = matchFootnoteDefinitionBlock(text, lineStart)
        if (block) {
          if (block.body.includes(']:')) {
            pending.push({ content: block.body, depth: current.depth + 1 })
          }
          const consumedEnd = lineStart + block.raw.length
          if (consumedEnd >= text.length) {
            break
          }
          lineStart = consumedEnd > lineStart ? consumedEnd : nextLineStart
          continue
        }
      }

      if (SINGLE_LINE_REFERENCE_LINK_PATTERN.test(line)) {
        return true
      }

      if (MULTILINE_REFERENCE_LINK_LABEL_PATTERN.test(line) && lineEnd < text.length) {
        const nextBounds = getLineBounds(text, nextLineStart)
        if (
          MULTILINE_REFERENCE_LINK_TARGET_PATTERN.test(
            text.slice(nextLineStart, nextBounds.lineEnd)
          )
        ) {
          return true
        }
      }

      if (nextLineStart <= lineStart || lineEnd === text.length) {
        break
      }
      lineStart = nextLineStart
    }
  }

  return false
}

export function preservesFootnotes(
  contentWithoutCode: string,
  roundTripOutput: string,
  roundTripWithoutCode: string
): boolean {
  if (
    TRANSPORT_ENVELOPE_PATTERN.test(roundTripOutput) &&
    !TRANSPORT_ENVELOPE_PATTERN.test(contentWithoutCode)
  ) {
    return false
  }

  const cleanSource = stripClosedHtmlComments(contentWithoutCode)
  const candidateLineCount = countFootnoteCandidateLines(cleanSource)
  const expectedDefs = collectFootnoteDefinitionIdentifiersInOrder(cleanSource)
  if (expectedDefs.length === 0 || expectedDefs.length !== candidateLineCount) {
    return false
  }

  const cleanRoundTrip = stripClosedHtmlComments(roundTripWithoutCode)
  const actualDefs = collectFootnoteDefinitionIdentifiersInOrder(cleanRoundTrip)
  if (
    actualDefs.length !== expectedDefs.length ||
    expectedDefs.some((identifier, index) => actualDefs[index] !== identifier)
  ) {
    return false
  }

  const definedIdentifiers = new Set(expectedDefs.map(normalizeFootnoteIdentifier))
  const expectedRefs = collectFootnoteReferencesInOrder(cleanSource, definedIdentifiers)
  const actualRefs = collectFootnoteReferencesInOrder(cleanRoundTrip, definedIdentifiers)
  return (
    actualRefs.length === expectedRefs.length &&
    expectedRefs.every((identifier, index) => actualRefs[index] === identifier)
  )
}

function collectFootnoteDefinitionIdentifiersInOrder(contentWithoutCode: string): string[] {
  const identifiers: string[] = []
  if (!contentWithoutCode.includes('[^')) {
    return identifiers
  }
  let lineStart = 0
  while (lineStart <= contentWithoutCode.length) {
    const { lineEnd, nextLineStart } = getLineBounds(contentWithoutCode, lineStart)
    const unwrapped = contentWithoutCode
      .slice(lineStart, lineEnd)
      .replace(BLOCKQUOTE_PREFIX_PATTERN, '')
    const identifier = extractFootnoteDefinitionIdentifier(unwrapped)
    if (identifier) {
      identifiers.push(identifier)
    }
    if (nextLineStart <= lineStart || lineEnd === contentWithoutCode.length) {
      break
    }
    lineStart = nextLineStart
  }
  return identifiers
}

function countFootnoteCandidateLines(contentWithoutCode: string): number {
  let count = 0
  let lineStart = 0
  while (lineStart <= contentWithoutCode.length) {
    const newlineIndex = contentWithoutCode.indexOf('\n', lineStart)
    const rawEnd = newlineIndex === -1 ? contentWithoutCode.length : newlineIndex
    const lineEnd =
      rawEnd > lineStart && contentWithoutCode.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd
    if (FOOTNOTE_CANDIDATE_LINE_PATTERN.test(contentWithoutCode.slice(lineStart, lineEnd))) {
      count += 1
    }
    if (newlineIndex === -1) {
      break
    }
    lineStart = newlineIndex + 1
  }
  return count
}

function isEscaped(content: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function collectFootnoteReferencesInOrder(
  contentWithoutCode: string,
  definedIdentifiers: ReadonlySet<string>
): string[] {
  const references: string[] = []
  if (definedIdentifiers.size === 0 || !contentWithoutCode.includes('[^')) {
    return references
  }
  let index = 0
  while (index < contentWithoutCode.length) {
    if (index === 0 || contentWithoutCode[index - 1] === '\n') {
      const prefixEnd = matchFootnoteDefinitionLinePrefix(contentWithoutCode, index)
      if (prefixEnd !== null) {
        index = prefixEnd
        continue
      }
    }
    if (
      contentWithoutCode[index] === '[' &&
      contentWithoutCode[index + 1] === '^' &&
      !isEscaped(contentWithoutCode, index)
    ) {
      const matched = matchFootnoteReferenceSource(contentWithoutCode, index, definedIdentifiers)
      if (matched) {
        references.push(matched.identifier)
        index = matched.end
        continue
      }
    }
    index += 1
  }
  return references
}
