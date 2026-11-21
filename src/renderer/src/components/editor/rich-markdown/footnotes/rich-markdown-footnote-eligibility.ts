import {
  collectFootnoteDefinitionIdentifiersInOrder,
  isFootnoteDefinitionLine,
  matchFootnoteDefinitionLinePrefix,
  matchFootnoteReferenceSource,
  normalizeFootnoteIdentifier
} from './rich-markdown-footnote-source'

export const FOOTNOTE_CANDIDATE_PATTERN = /^ {0,3}(?:> ?)* {0,3}\[\^[^\s[\]]+\]:/m

const FOOTNOTE_CANDIDATE_LINE_PATTERN = /^ {0,3}(?:> ?)* {0,3}\[\^[^\s[\]]+\]:/
const REFERENCE_LINK_LINE_PATTERN = /^\[[^\]]+\]:\s+\S+/
const TRANSPORT_ENVELOPE_PATTERN = /\[\[ORCA_RICH_MD:[a-f0-9]{32}:/

export function hasNonFootnoteReferenceLinkCandidate(contentWithoutCode: string): boolean {
  let lineStart = 0
  while (lineStart <= contentWithoutCode.length) {
    const newlineIndex = contentWithoutCode.indexOf('\n', lineStart)
    const rawEnd = newlineIndex === -1 ? contentWithoutCode.length : newlineIndex
    const lineEnd =
      rawEnd > lineStart && contentWithoutCode.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd
    const line = contentWithoutCode.slice(lineStart, lineEnd)
    if (REFERENCE_LINK_LINE_PATTERN.test(line) && !isFootnoteDefinitionLine(line)) {
      return true
    }
    if (newlineIndex === -1) {
      break
    }
    lineStart = newlineIndex + 1
  }
  return false
}

export function preservesFootnotes(contentWithoutCode: string, roundTripOutput: string): boolean {
  if (
    TRANSPORT_ENVELOPE_PATTERN.test(roundTripOutput) &&
    !TRANSPORT_ENVELOPE_PATTERN.test(contentWithoutCode)
  ) {
    return false
  }

  const candidateLineCount = countFootnoteCandidateLines(contentWithoutCode)
  const expectedDefs = collectFootnoteDefinitionIdentifiersInOrder(contentWithoutCode)
  if (expectedDefs.length === 0 || expectedDefs.length !== candidateLineCount) {
    return false
  }

  const roundTripWithoutCode = stripCodeForFootnoteProof(roundTripOutput)
  const actualDefs = collectFootnoteDefinitionIdentifiersInOrder(roundTripWithoutCode)
  if (
    actualDefs.length !== expectedDefs.length ||
    expectedDefs.some((identifier, index) => actualDefs[index] !== identifier)
  ) {
    return false
  }

  const definedIdentifiers = new Set(expectedDefs.map(normalizeFootnoteIdentifier))
  const expectedRefs = collectFootnoteReferencesInOrder(contentWithoutCode, definedIdentifiers)
  const actualRefs = collectFootnoteReferencesInOrder(roundTripWithoutCode, definedIdentifiers)
  return (
    actualRefs.length === expectedRefs.length &&
    expectedRefs.every((identifier, index) => actualRefs[index] === identifier)
  )
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

function stripInlineCodeSpans(line: string): string {
  if (!line.includes('`')) {
    return line
  }
  let output = ''
  let index = 0
  while (index < line.length) {
    if (line[index] !== '`') {
      output += line[index]
      index += 1
      continue
    }
    let tickCount = 0
    while (line[index + tickCount] === '`') {
      tickCount += 1
    }
    let searchFrom = index + tickCount
    let closingIndex = -1
    const delimiter = '`'.repeat(tickCount)
    while (searchFrom < line.length) {
      const candidate = line.indexOf(delimiter, searchFrom)
      if (candidate === -1) {
        break
      }
      if ((candidate === 0 || line[candidate - 1] !== '`') && line[candidate + tickCount] !== '`') {
        closingIndex = candidate
        break
      }
      searchFrom = candidate + 1
    }
    if (closingIndex !== -1) {
      index = closingIndex + tickCount
      continue
    }
    output += delimiter
    index += tickCount
  }
  return output
}

function stripCodeForFootnoteProof(content: string): string {
  let sanitized = ''
  let activeFence: '`' | '~' | null = null
  let activeFenceLength = 0
  let lineStart = 0

  while (lineStart <= content.length) {
    const newlineIndex = content.indexOf('\n', lineStart)
    const rawEnd = newlineIndex === -1 ? content.length : newlineIndex
    const lineEnd =
      rawEnd > lineStart && content.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd
    const line = content.slice(lineStart, lineEnd)
    const fenceMatch = /^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})(.*)$/.exec(line)

    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
      const length = fenceMatch[1].length
      const trailing = fenceMatch[2]
      if (activeFence === null) {
        if (marker === '~' || !trailing.includes('`')) {
          activeFence = marker
          activeFenceLength = length
        } else {
          sanitized += stripInlineCodeSpans(line)
        }
      } else if (
        activeFence === marker &&
        length >= activeFenceLength &&
        /^[ \t]*$/.test(trailing)
      ) {
        activeFence = null
        activeFenceLength = 0
      }
    } else if (!activeFence) {
      sanitized += stripInlineCodeSpans(line)
    }

    if (newlineIndex === -1) {
      break
    }
    sanitized += '\n'
    lineStart = newlineIndex + 1
  }

  return sanitized
}
