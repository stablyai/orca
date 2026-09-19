import {
  extractDetailsSummaryHtml,
  hasHtmlTagOutsideCode,
  hasOnlyPlainParagraphAndBreakTags,
  hasOnlySupportedDetailsAttributes,
  indexOfAsciiIgnoreCase,
  matchDetailsHtmlBlock,
  type DetailsHtmlBlock
} from './details-markdown-html'
import {
  isInsideRange,
  markdownCodeSpanRanges,
  markdownFenceRanges,
  type MarkdownFenceRanges
} from './markdown-scan-ranges'

const MAX_DETAILS_NESTING_LEVELS = 16

function stripEditableNestedDetails(bodyHtml: string, nestingLevel: number): string | null {
  let result = ''
  let index = 0
  let fenceRanges: MarkdownFenceRanges | null = null
  let codeSpanRanges: MarkdownFenceRanges | null = null
  let searchFrom = 0

  for (;;) {
    const nestedStart = indexOfAsciiIgnoreCase(bodyHtml, '<details', searchFrom)
    if (nestedStart === -1) {
      return result + bodyHtml.slice(index)
    }
    fenceRanges ??= markdownFenceRanges(bodyHtml)
    codeSpanRanges ??= markdownCodeSpanRanges(bodyHtml, fenceRanges)
    if (isInsideRange(nestedStart, fenceRanges) || isInsideRange(nestedStart, codeSpanRanges)) {
      searchFrom = nestedStart + 1
      continue
    }
    if (nestingLevel >= MAX_DETAILS_NESTING_LEVELS) {
      return null
    }
    const nested = matchDetailsHtmlBlock(bodyHtml, nestedStart, fenceRanges, codeSpanRanges)
    if (!nested || !isEditableDetailsHtmlBlock(nested, nestingLevel + 1)) {
      return null
    }
    result += bodyHtml.slice(index, nestedStart)
    index = nestedStart + nested.raw.length
    searchFrom = index
  }
}

export function isEditableDetailsHtmlBlock(block: DetailsHtmlBlock, nestingLevel = 1): boolean {
  const summary = extractDetailsSummaryHtml(block.inner)
  const bodyHtml =
    summary && !summary.attributes.trim() && !hasHtmlTagOutsideCode(summary.content)
      ? stripEditableNestedDetails(block.inner.slice(summary.rawLength), nestingLevel)
      : null
  if (
    !hasOnlySupportedDetailsAttributes(block.openingAttributes) ||
    !summary ||
    bodyHtml === null ||
    !hasOnlyPlainParagraphAndBreakTags(bodyHtml)
  ) {
    return false
  }
  // Why: blanking allowed tags preserves offsets for the shared range scans.
  return !hasHtmlTagOutsideCode(
    bodyHtml
      .replace(/<\/?p\b[^>]*>/gi, (tag) => ' '.repeat(tag.length))
      .replace(/<br\s*\/?>/gi, (tag) => ' '.repeat(tag.length))
  )
}
