import type { MarkdownToken } from '@tiptap/core'

export const DETAILS_CLOSE_TAG = '</details>'

export type DetailsHtmlToken = MarkdownToken & {
  attributes?: Record<string, unknown>
  bodyTokens?: MarkdownToken[]
  summaryTokens?: MarkdownToken[]
}

export type DetailsHtmlBlock = {
  raw: string
  openingAttributes: string
  inner: string
  hasNestedDetails: boolean
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
  return {
    open: /\sopen(?:\s|=|$)/i.test(rawAttributes),
    variant: /\sdata-orca-toggle=(?:"heading-1"|'heading-1'|heading-1)(?:\s|$)/i.test(rawAttributes)
      ? 'heading-1'
      : null
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

  if (attrs?.variant === 'heading-1') {
    attributes.push('data-orca-toggle="heading-1"')
  }

  if (attrs?.open === true) {
    attributes.push('open')
  }

  return attributes.join(' ')
}

function markdownFenceRanges(content: string): [number, number][] {
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

function isInsideRange(index: number, ranges: [number, number][]): boolean {
  return ranges.some(([start, end]) => index >= start && index < end)
}

export function matchDetailsHtmlBlock(content: string, start: number): DetailsHtmlBlock | null {
  const openingMatch = content.slice(start).match(/^<details\b[^>]*>/i)
  if (!openingMatch) {
    return null
  }

  const detailsTagPattern = /<\/?details\b[^>]*>/gi
  detailsTagPattern.lastIndex = start
  const fenceRanges = markdownFenceRanges(content)

  let depth = 0
  let hasNestedDetails = false

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
          inner: content.slice(start + openingMatch[0].length, tagMatch.index),
          hasNestedDetails
        }
      }
    } else {
      if (depth > 0) {
        hasNestedDetails = true
      }
      depth += 1
    }
  }
}

function hasOnlySupportedDetailsAttributes(rawAttributes: string): boolean {
  return (
    rawAttributes
      .replace(/\s+open(?:\s*=\s*(?:""|"open"|''|'open'|open))?(?=\s|$)/giu, '')
      .replace(/\s+class\s*=\s*(?:"orca-details"|'orca-details'|orca-details)(?=\s|$)/giu, '')
      .replace(/\s+data-orca-toggle\s*=\s*(?:"heading-1"|'heading-1'|heading-1)(?=\s|$)/giu, '')
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

export function isEditableDetailsHtmlBlock(block: DetailsHtmlBlock): boolean {
  if (block.hasNestedDetails) {
    return false
  }

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

  const bodyHtml = block.inner.slice(summary.rawLength)
  if (!hasOnlyPlainParagraphAndBreakTags(bodyHtml)) {
    return false
  }

  const allowedHtmlRemoved = bodyHtml.replace(/<\/?p\b[^>]*>/gi, '').replace(/<br\s*\/?>/gi, '')

  return !/<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>/.test(allowedHtmlRemoved)
}
