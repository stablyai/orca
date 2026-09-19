import type { MarkdownToken } from '@tiptap/core'
import {
  isInsideRange,
  markdownCodeSpanRanges,
  markdownFenceRanges,
  type MarkdownFenceRanges
} from './markdown-scan-ranges'

// Toggle summaries can render at heading scales 1–5, mirroring the plain
// heading levels the slash menu / toolbar dropdown offer (h1–h5).
export type ToggleHeadingVariant =
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'

export const TOGGLE_HEADING_VARIANTS: readonly ToggleHeadingVariant[] = [
  'heading-1',
  'heading-2',
  'heading-3',
  'heading-4',
  'heading-5'
]

export function parseToggleHeadingVariant(value: unknown): ToggleHeadingVariant | null {
  return typeof value === 'string' &&
    TOGGLE_HEADING_VARIANTS.includes(value as ToggleHeadingVariant)
    ? (value as ToggleHeadingVariant)
    : null
}
export type DetailsHtmlToken = MarkdownToken & {
  attributes?: Record<string, unknown>
  bodyTokens?: MarkdownToken[]
  summaryTokens?: MarkdownToken[]
}

export type DetailsHtmlBlock = {
  raw: string
  openingAttributes: string
  inner: string
}
export type DetailsSummaryHtml = {
  attributes: string
  content: string
  rawLength: number
}
export function escapeDetailsHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
const LEGACY_STYLING_CLASS_PATTERN =
  /\sclass\s*=\s*(?:"orca-details"|'orca-details'|orca-details)(?=\s|$)/i

export function parseDetailsAttributes(rawAttributes: string): Record<string, unknown> {
  // Why: validation accepts normal HTML whitespace around `=`, so parsing
  // must accept it too or an editable toggle loses its heading variant.
  const variantMatch = rawAttributes.match(
    /\sdata-orca-toggle\s*=\s*(?:"(heading-[1-5])"|'(heading-[1-5])'|(heading-[1-5]))(?:\s|$)/i
  )
  return {
    open: /\sopen(?:\s|=|$)/i.test(rawAttributes),
    variant: parseToggleHeadingVariant(
      (variantMatch?.[1] ?? variantMatch?.[2] ?? variantMatch?.[3])?.toLowerCase()
    ),
    hasLegacyStylingClass: LEGACY_STYLING_CLASS_PATTERN.test(rawAttributes)
  }
}
export function detailsBodyHtmlToMarkdown(body: string): string {
  return body
    .replace(/<p\b[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .trim()
}
export function renderDetailsAttributes(attrs: Record<string, unknown> | undefined): string {
  const attributes: string[] = []

  if (attrs?.hasLegacyStylingClass === true) {
    attributes.push('class="orca-details"')
  }

  const variant = parseToggleHeadingVariant(attrs?.variant)
  if (variant) {
    attributes.push(`data-orca-toggle="${variant}"`)
  }

  if (attrs?.open === true) {
    attributes.push('open')
  }

  return attributes.join(' ')
}

export function findDetailsBlockStart(content: string): number {
  if (!/<details\b/i.test(content)) {
    return -1
  }
  const fenceRanges = markdownFenceRanges(content)
  const codeSpanRanges = markdownCodeSpanRanges(content)
  const tagPattern = /<details\b/gi

  for (;;) {
    const match = tagPattern.exec(content)
    if (!match) {
      return -1
    }
    const index = match.index
    if (isInsideRange(index, fenceRanges) || isInsideRange(index, codeSpanRanges)) {
      continue
    }
    const lineStart =
      Math.max(content.lastIndexOf('\n', index - 1), content.lastIndexOf('\r', index - 1)) + 1
    const indent = content.slice(lineStart, index)
    if (indent.length <= 3 && /^ *$/.test(indent)) {
      return index
    }
  }
}

export function matchDetailsHtmlBlock(
  content: string,
  start: number,
  // Ranges depend only on `content`, so callers scanning one body repeatedly
  // compute them once and share them across sibling matches.
  precomputedFenceRanges?: MarkdownFenceRanges,
  precomputedCodeSpanRanges?: MarkdownFenceRanges
): DetailsHtmlBlock | null {
  const openingMatch = content.slice(start).match(/^<details\b[^>]*>/i)
  if (!openingMatch) {
    return null
  }

  const detailsTagPattern = /<\/?details\b[^>]*>/gi
  detailsTagPattern.lastIndex = start
  const fenceRanges = precomputedFenceRanges ?? markdownFenceRanges(content)
  const codeSpanRanges = precomputedCodeSpanRanges ?? markdownCodeSpanRanges(content)

  let depth = 0

  for (;;) {
    const tagMatch = detailsTagPattern.exec(content)
    if (!tagMatch) {
      return null
    }

    const tag = tagMatch[0]
    if (
      tagMatch.index !== start &&
      (isInsideRange(tagMatch.index, fenceRanges) || isInsideRange(tagMatch.index, codeSpanRanges))
    ) {
      continue
    }

    const isClosingTag = /^<\/details\b/i.test(tag)

    if (isClosingTag) {
      depth -= 1
      if (depth === 0) {
        const closingEnd = tagMatch.index + tag.length
        return {
          raw: content.slice(start, closingEnd),
          openingAttributes: openingMatch[0].replace(/^<details\b/i, '').replace(/>$/u, ''),
          inner: content.slice(start + openingMatch[0].length, tagMatch.index)
        }
      }
    } else {
      depth += 1
    }
  }
}

export function hasOnlySupportedDetailsAttributes(rawAttributes: string): boolean {
  return (
    rawAttributes
      .replace(/\s+open(?:\s*=\s*(?:""|"open"|''|'open'|open))?(?=\s|$)/giu, '')
      // HTML attribute names ignore case; class tokens do not.
      .replace(
        /\s+[cC][lL][aA][sS][sS]\s*=\s*(?:"orca-details"|'orca-details'|orca-details)(?=\s|$)/gu,
        ''
      )
      .replace(
        /\s+data-orca-toggle\s*=\s*(?:"heading-[1-5]"|'heading-[1-5]'|heading-[1-5])(?=\s|$)/giu,
        ''
      )
      .trim() === ''
  )
}

export function normalizeDetailsOpeningTag(fragment: string): string {
  const match = fragment.match(/^<details(\s[^<>]*)?>$/i)
  const attributes = match?.[1] ?? ''
  if (!match || !hasOnlySupportedDetailsAttributes(attributes)) {
    return fragment
  }
  const renderedAttributes = renderDetailsAttributes(parseDetailsAttributes(attributes))
  return renderedAttributes ? `<details ${renderedAttributes}>` : '<details>'
}

export function hasOnlyPlainParagraphAndBreakTags(content: string): boolean {
  return !/<p\b(?!\s*>)[^>]*>|<br\b(?!\s*\/?>)[^>]*>/iu.test(content)
}

const HTML_TAG_PATTERN = /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>/g

// Tag-shaped text inside fenced or inline code is prose the editor round-trips
// verbatim, so it leaves the block editable.
export function hasHtmlTagOutsideCode(content: string): boolean {
  const fenceRanges = markdownFenceRanges(content)
  const codeSpanRanges = markdownCodeSpanRanges(content, fenceRanges)
  HTML_TAG_PATTERN.lastIndex = 0

  for (;;) {
    const match = HTML_TAG_PATTERN.exec(content)
    if (!match) {
      return false
    }
    if (!isInsideRange(match.index, fenceRanges) && !isInsideRange(match.index, codeSpanRanges)) {
      return true
    }
  }
}

export function extractDetailsSummaryHtml(inner: string): DetailsSummaryHtml | null {
  let startIndex = 0
  while (startIndex < inner.length && isHtmlWhitespace(inner.charCodeAt(startIndex))) {
    startIndex++
  }

  const tagName = '<summary'
  if (!startsWithAsciiIgnoreCase(inner, tagName, startIndex)) {
    return null
  }
  if (isHtmlTagNamePart(inner.charCodeAt(startIndex + tagName.length))) {
    return null
  }

  const openingEndIndex = inner.indexOf('>', startIndex + tagName.length)
  if (openingEndIndex === -1) {
    return null
  }
  const closingTag = '</summary>'
  const closingStartIndex = indexOfAsciiIgnoreCase(inner, closingTag, openingEndIndex + 1)
  if (closingStartIndex === -1) {
    return null
  }

  return {
    attributes: inner.slice(startIndex + tagName.length, openingEndIndex),
    content: inner.slice(openingEndIndex + 1, closingStartIndex),
    rawLength: closingStartIndex + closingTag.length
  }
}

function isHtmlWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32
}

export function indexOfAsciiIgnoreCase(value: string, search: string, fromIndex: number): number {
  const lastStart = value.length - search.length
  for (let index = Math.max(0, fromIndex); index <= lastStart; index++) {
    if (startsWithAsciiIgnoreCase(value, search, index)) {
      return index
    }
  }
  return -1
}

function startsWithAsciiIgnoreCase(value: string, search: string, startIndex: number): boolean {
  if (startIndex < 0 || startIndex + search.length > value.length) {
    return false
  }
  for (let index = 0; index < search.length; index++) {
    if (toLowerAsciiCode(value.charCodeAt(startIndex + index)) !== search.charCodeAt(index)) {
      return false
    }
  }
  return true
}

function toLowerAsciiCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code
}

function isHtmlTagNamePart(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  )
}
