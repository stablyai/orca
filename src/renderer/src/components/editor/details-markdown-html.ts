import type { MarkdownToken } from '@tiptap/core'

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

// Fence ranges depend only on the scanned string, so callers scanning one body
// repeatedly compute them once and share them across sibling matches.
export type MarkdownFenceRanges = readonly (readonly [number, number])[]

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
  // Why: validation accepts normal HTML whitespace around `=`, so parsing
  // must accept it too or an editable toggle loses its heading variant.
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

function markdownFenceRanges(content: string): MarkdownFenceRanges {
  const ranges: [number, number][] = []
  let offset = 0
  let openFence: { marker: '`' | '~'; length: number; start: number } | null = null

  for (const lineMatch of content.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const line = lineMatch[0]
    if (line === '') {
      break
    }

    const lineText = line.replace(/(?:\r\n|\n|\r)$/u, '')
    if (openFence) {
      const closingFencePattern =
        openFence.marker === '`'
          ? new RegExp(`^ {0,3}\`{${openFence.length},}\\s*$`)
          : new RegExp(`^ {0,3}~{${openFence.length},}\\s*$`)
      if (closingFencePattern.test(lineText)) {
        ranges.push([openFence.start, offset + line.length])
        openFence = null
      }
    } else {
      const openingFenceMatch = lineText.match(/^ {0,3}(`{3,}|~{3,})/u)
      if (openingFenceMatch?.[1]) {
        openFence = {
          marker: openingFenceMatch[1][0] as '`' | '~',
          length: openingFenceMatch[1].length,
          start: offset
        }
      }
    }

    offset += line.length
  }

  if (openFence) {
    ranges.push([openFence.start, content.length])
  }

  return ranges
}

function isInsideRange(index: number, ranges: MarkdownFenceRanges): boolean {
  return ranges.some(([start, end]) => index >= start && index < end)
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
  const fenceRanges = precomputedFenceRanges ?? markdownFenceRanges(content)

  let depth = 0

  for (;;) {
    const tagMatch = detailsTagPattern.exec(content)
    if (!tagMatch) {
      return null
    }

    const tag = tagMatch[0]
    if (tagMatch.index !== start && isInsideRange(tagMatch.index, fenceRanges)) {
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
      .replace(/\s+class\s*=\s*(?:"orca-details"|'orca-details'|orca-details)(?=\s|$)/giu, '')
      .replace(
        /\s+data-orca-toggle\s*=\s*(?:"heading-[1-5]"|'heading-[1-5]'|heading-[1-5])(?=\s|$)/giu,
        ''
      )
      .trim() === ''
  )
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

// Why: nested toggles validate recursively and each level rescans its own body,
// so a pathological file would otherwise blow the stack or go quadratic.
const MAX_DETAILS_NESTING_LEVELS = 16

// Removes nested toggles that are themselves editable, so the caller's raw-tag
// scan sees only the body's own markup. Null when a nested toggle can't be one.
function stripEditableNestedDetails(bodyHtml: string, nestingLevel: number): string | null {
  let result = ''
  let index = 0
  // Why: without sharing this, N sibling toggles rescan the whole body N times.
  let fenceRanges: MarkdownFenceRanges | null = null

  for (;;) {
    const nestedStart = indexOfAsciiIgnoreCase(bodyHtml, '<details', index)
    if (nestedStart === -1) {
      return result + bodyHtml.slice(index)
    }

    if (nestingLevel >= MAX_DETAILS_NESTING_LEVELS) {
      return null
    }

    fenceRanges ??= markdownFenceRanges(bodyHtml)
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
