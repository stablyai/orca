import type { MarkdownToken } from '@tiptap/core'
import {
  getMarkdownFenceRanges,
  isInsideMarkdownFenceRange,
  type MarkdownFenceRanges
} from './markdown-fence-scanner'

// Match the slash menu and toolbar’s heading scales.
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

export function parseDetailsAttributes(rawAttributes: string): Record<string, unknown> {
  // Match validation’s whitespace rules around = or editable toggles lose heading variants.
  const variantMatch = rawAttributes.match(
    /\sdata-orca-toggle\s*=\s*(?:"(heading-[1-5])"|'(heading-[1-5])'|(heading-[1-5]))(?:\s|$)/i
  )
  return {
    open: /\sopen(?:\s|=|$)/i.test(rawAttributes),
    variant: parseToggleHeadingVariant(
      (variantMatch?.[1] ?? variantMatch?.[2] ?? variantMatch?.[3])?.toLowerCase()
    )
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
  const attributes = ['class="orca-details"']

  const variant = parseToggleHeadingVariant(attrs?.variant)
  if (variant) {
    attributes.push(`data-orca-toggle="${variant}"`)
  }

  if (attrs?.open === true) {
    attributes.push('open')
  }

  return attributes.join(' ')
}

export function createDetailsMatcher(content: string): (start: number) => DetailsHtmlBlock | null {
  let fenceRanges: MarkdownFenceRanges | undefined
  return (start) =>
    /^<details\b[^>]*>/i.test(content.slice(start))
      ? matchDetailsHtmlBlock(content, start, (fenceRanges ??= getMarkdownFenceRanges(content)))
      : null
}

export function matchDetailsHtmlBlock(
  content: string,
  start: number,
  precomputedFenceRanges?: MarkdownFenceRanges
): DetailsHtmlBlock | null {
  const openingMatch = content.slice(start).match(/^<details\b[^>]*>/i)
  if (!openingMatch) {
    return null
  }

  const detailsTagPattern = /<\/?details\b[^>]*>/gi
  detailsTagPattern.lastIndex = start
  const fenceRanges = precomputedFenceRanges ?? getMarkdownFenceRanges(content)

  let depth = 0

  for (;;) {
    const tagMatch = detailsTagPattern.exec(content)
    if (!tagMatch) {
      return null
    }

    const tag = tagMatch[0]
    if (tagMatch.index !== start && isInsideMarkdownFenceRange(tagMatch.index, fenceRanges)) {
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

function hasOnlySupportedDetailsAttributes(rawAttributes: string): boolean {
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
  return `<details ${renderDetailsAttributes(parseDetailsAttributes(attributes))}>`
}

function hasOnlyPlainParagraphAndBreakTags(content: string): boolean {
  return !/<p\b(?!\s*>)[^>]*>|<br\b(?!\s*\/?>)[^>]*>/iu.test(content)
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

function indexOfAsciiIgnoreCase(value: string, search: string, fromIndex: number): number {
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

// Bound recursive rescanning to avoid stack exhaustion and quadratic work on pathological nesting.
const MAX_DETAILS_NESTING_LEVELS = 16

// Remove editable nested toggles before scanning this body’s raw tags; null means a nested toggle is unsupported.
function stripEditableNestedDetails(bodyHtml: string, nestingLevel: number): string | null {
  let result = ''
  let index = 0
  // Share fence ranges so sibling toggles cannot rescan the entire body per sibling.
  let fenceRanges: MarkdownFenceRanges | null = null

  for (;;) {
    const nestedStart = indexOfAsciiIgnoreCase(bodyHtml, '<details', index)
    if (nestedStart === -1) {
      return result + bodyHtml.slice(index)
    }

    if (nestingLevel >= MAX_DETAILS_NESTING_LEVELS) {
      return null
    }

    fenceRanges ??= getMarkdownFenceRanges(bodyHtml)
    const nested = matchDetailsHtmlBlock(bodyHtml, nestedStart, fenceRanges)
    if (!nested || !isEditableDetailsHtmlBlock(nested, nestingLevel + 1)) {
      return null
    }

    result += bodyHtml.slice(index, nestedStart)
    index = nestedStart + nested.raw.length
  }
}

export function isEditableDetailsHtmlBlock(block: DetailsHtmlBlock, nestingLevel = 1): boolean {
  if (!hasOnlySupportedDetailsAttributes(block.openingAttributes)) {
    return false
  }

  const summary = extractDetailsSummaryHtml(block.inner)
  if (!summary) {
    return false
  }

  if (summary.attributes.trim()) {
    return false
  }

  if (/<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>/.test(summary.content)) {
    return false
  }

  const bodyHtml = stripEditableNestedDetails(block.inner.slice(summary.rawLength), nestingLevel)
  if (bodyHtml === null) {
    return false
  }

  if (!hasOnlyPlainParagraphAndBreakTags(bodyHtml)) {
    return false
  }

  const allowedHtmlRemoved = bodyHtml.replace(/<\/?p\b[^>]*>/gi, '').replace(/<br\s*\/?>/gi, '')

  return !/<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>/.test(allowedHtmlRemoved)
}
