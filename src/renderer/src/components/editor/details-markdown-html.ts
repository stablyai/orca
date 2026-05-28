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

export function isEditableDetailsHtmlBlock(block: DetailsHtmlBlock): boolean {
  if (block.hasNestedDetails) {
    return false
  }

  if (!hasOnlySupportedDetailsAttributes(block.openingAttributes)) {
    return false
  }

  const summaryMatch = block.inner.match(/^\s*<summary\b([^>]*)>([\s\S]*?)<\/summary>/i)
  if (!summaryMatch) {
    return false
  }

  if (summaryMatch[1]?.trim()) {
    return false
  }

  if (/<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>/.test(summaryMatch[2] ?? '')) {
    return false
  }

  const bodyHtml = block.inner.replace(/^\s*<summary\b[^>]*>[\s\S]*?<\/summary>/i, '')
  if (!hasOnlyPlainParagraphAndBreakTags(bodyHtml)) {
    return false
  }

  const allowedHtmlRemoved = bodyHtml.replace(/<\/?p\b[^>]*>/gi, '').replace(/<br\s*\/?>/gi, '')

  return !/<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>/.test(allowedHtmlRemoved)
}
