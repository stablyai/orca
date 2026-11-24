import { buildLocaleLowercaseIndex } from '../../../../shared/locale-lowercase-index'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard/clipboard-text'

export const TEXT_SEARCH_QUERY_MAX_BYTES = 2 * 1024

export function isTextSearchQueryTooLarge(
  query: string,
  maxBytes = TEXT_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export type TextMatchOptions = {
  matchCase?: boolean
  wholeWord?: boolean
}

export function findTextMatchRanges(
  text: string,
  query: string,
  options: TextMatchOptions = {}
): { start: number; end: number }[] {
  if (!query) {
    return []
  }
  if (isTextSearchQueryTooLarge(query)) {
    return []
  }

  const ranges = options.matchCase
    ? findCaseSensitiveMatchRanges(text, query)
    : findCaseInsensitiveMatchRanges(text, query)

  if (!options.wholeWord) {
    return ranges
  }
  return ranges.filter((range) => isWholeWordMatch(text, range.start, range.end))
}

function findCaseSensitiveMatchRanges(
  text: string,
  query: string
): { start: number; end: number }[] {
  const matches: { start: number; end: number }[] = []
  let searchStart = 0

  while (searchStart <= text.length - query.length) {
    const matchStart = text.indexOf(query, searchStart)
    if (matchStart === -1) {
      break
    }
    matches.push({ start: matchStart, end: matchStart + query.length })
    searchStart = matchStart + query.length
  }

  return matches
}

function findCaseInsensitiveMatchRanges(
  text: string,
  query: string
): { start: number; end: number }[] {
  const normalizedText = buildLocaleLowercaseIndex(text)
  const normalizedQuery = buildLocaleLowercaseIndex(query).text
  const matches: { start: number; end: number }[] = []
  let searchStart = 0

  while (searchStart <= normalizedText.text.length - normalizedQuery.length) {
    const matchStart = normalizedText.text.indexOf(normalizedQuery, searchStart)
    if (matchStart === -1) {
      break
    }

    const matchEnd = matchStart + normalizedQuery.length
    matches.push({
      start: normalizedText.originalStartByNormalizedOffset?.[matchStart] ?? matchStart,
      end: normalizedText.originalEndByNormalizedOffset?.[matchEnd - 1] ?? matchEnd
    })
    // Advance at least one even if future locale normalization yields an empty query.
    searchStart = matchEnd + (normalizedQuery.length === 0 ? 1 : 0)
  }

  return matches
}

// Combining marks stay attached to their letters when checking whole-word boundaries.
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}_]/u
const COMBINING_MARK = /\p{M}/u
const ENCLOSING_MARK = /\p{Me}/u

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && WORD_CHARACTER.test(char)
}

function codePointBefore(text: string, index: number): string | undefined {
  if (index <= 0) {
    return undefined
  }

  const previousCodeUnit = text.charCodeAt(index - 1)
  if (
    previousCodeUnit >= 0xdc00 &&
    previousCodeUnit <= 0xdfff &&
    index > 1 &&
    text.charCodeAt(index - 2) >= 0xd800 &&
    text.charCodeAt(index - 2) <= 0xdbff
  ) {
    return text.slice(index - 2, index)
  }

  return text[index - 1]
}

function codePointAt(text: string, index: number): string | undefined {
  const codePoint = text.codePointAt(index)
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint)
}

// A leading mark belongs to the preceding base (emoji+VS16 stays a boundary); enclosing marks make a symbol (keycaps).
function isWordGraphemeBefore(text: string, index: number): boolean {
  let offset = index
  let codePoint = codePointBefore(text, offset)
  while (codePoint !== undefined && COMBINING_MARK.test(codePoint)) {
    if (ENCLOSING_MARK.test(codePoint)) {
      return false
    }
    offset -= codePoint.length
    codePoint = codePointBefore(text, offset)
  }
  return isWordCharacter(codePoint)
}

function isWholeWordMatch(text: string, start: number, end: number): boolean {
  return !isWordGraphemeBefore(text, start) && !isWordCharacter(codePointAt(text, end))
}
