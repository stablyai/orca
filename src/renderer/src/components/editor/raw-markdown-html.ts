import { isEditableDetailsHtmlBlock, matchDetailsHtmlBlock } from './details-markdown-html'
import { formatMarkdownDocLinkBody, parseMarkdownDocLink } from './markdown-doc-links'
import { normalizeMarkdownReferenceLinks } from './markdown-reference-link-normalization'
import type { RichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { isReservedRichMarkdownTransportBody } from './rich-markdown-source-transport'
import { matchHtmlSuperscriptLinkSource } from './rich-markdown-html-superscript-link-source'
import { consumeMarkdownFenceDelimiterLine } from './raw-markdown-html-fence'

const INLINE_HTML_PATTERN = /^<!--[\s\S]*?-->|^<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>/

function matchInlineHtml(src: string): string | null {
  const match = src.match(INLINE_HTML_PATTERN)
  return match?.[0] ?? null
}

function isEscaped(content: string, index: number): boolean {
  let backslashCount = 0
  for (let i = index - 1; i >= 0 && content[i] === '\\'; i -= 1) {
    backslashCount += 1
  }
  return backslashCount % 2 === 1
}

function findLineEnd(content: string, start: number): number {
  const newlineIndex = content.indexOf('\n', start)
  return newlineIndex === -1 ? content.length : newlineIndex
}

function isLineOnlyHtml(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith('<')) {
    return false
  }

  if (trimmed.startsWith('<!--')) {
    return trimmed.includes('-->')
  }

  return /^<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>$/.test(trimmed)
}

function matchBlockHtml(content: string, start: number): string | null {
  const lineEnd = findLineEnd(content, start)
  const line = content.slice(start, lineEnd)
  if (!isLineOnlyHtml(line)) {
    return null
  }

  return line
}

export function encodeRawMarkdownHtmlForRichEditor(
  content: string,
  codec: RichMarkdownEditorCodec,
  { htmlSuperscriptLinks = false }: { htmlSuperscriptLinks?: boolean } = {}
): string {
  const normalizedContent = normalizeMarkdownReferenceLinks(content)
  const { transport } = codec
  let index = 0
  let isLineStart = true
  const fenceState = { activeFence: null as '`' | '~' | null, activeFenceLength: 0 }
  let result = ''
  while (index < normalizedContent.length) {
    if (isLineStart) {
      // Why: fence open/close must not let ^\s* cross newlines (#13307 / #7056).
      const fenceEnd = consumeMarkdownFenceDelimiterLine(normalizedContent, index, fenceState)
      if (fenceEnd !== null) {
        result += normalizedContent.slice(index, fenceEnd)
        isLineStart = fenceEnd > index && normalizedContent[fenceEnd - 1] === '\n'
        index = fenceEnd
        continue
      }
    }

    if (fenceState.activeFence) {
      const nextChar = normalizedContent[index]
      result += nextChar
      isLineStart = nextChar === '\n'
      index += 1
      continue
    }

    if (normalizedContent[index] === '`') {
      let tickCount = 0
      while (normalizedContent[index + tickCount] === '`') {
        tickCount += 1
      }

      // Why: the closing backtick sequence must be exactly tickCount backticks,
      // not a longer run. We scan forward to find the first exact match.
      let searchFrom = index + tickCount
      let closingIndex = -1
      while (searchFrom < normalizedContent.length) {
        const candidate = normalizedContent.indexOf('`'.repeat(tickCount), searchFrom)
        if (candidate === -1) {
          break
        }
        // Verify the match is exactly tickCount backticks (no extra backtick before/after)
        if (
          (candidate === 0 || normalizedContent[candidate - 1] !== '`') &&
          normalizedContent[candidate + tickCount] !== '`'
        ) {
          closingIndex = candidate
          break
        }
        searchFrom = candidate + 1
      }

      if (closingIndex !== -1) {
        const rawSpan = normalizedContent.slice(index, closingIndex + tickCount)
        result += rawSpan
        isLineStart = rawSpan.endsWith('\n')
        index = closingIndex + tickCount
        continue
      }
    }

    if (isLineStart) {
      const detailsHtml = matchDetailsHtmlBlock(normalizedContent, index)
      if (detailsHtml && isEditableDetailsHtmlBlock(detailsHtml)) {
        // Why: <details>/<summary> is an editable rich-mode node; raw passthrough
        // would make toggle blocks reopen as inert HTML instead.
        result += detailsHtml.raw
        index += detailsHtml.raw.length
        continue
      }

      if (detailsHtml) {
        result += transport.create('block-html', detailsHtml.raw)
        index += detailsHtml.raw.length
        continue
      }

      const blockHtml = matchBlockHtml(normalizedContent, index)
      if (blockHtml) {
        result += transport.create('block-html', blockHtml)
        index += blockHtml.length
        continue
      }
    }

    // Why: authored text that happens to contain this editor's random envelope
    // prefix must remain literal even in HTML-free documents and after edits.
    if (normalizedContent.startsWith(transport.authoredPrefix, index)) {
      const authoredEnd = normalizedContent.indexOf(']]', index + transport.authoredPrefix.length)
      const authoredOccurrence =
        authoredEnd === -1
          ? transport.authoredPrefix
          : normalizedContent.slice(index, authoredEnd + 2)
      result += transport.create('literal', authoredOccurrence)
      index += authoredOccurrence.length
      continue
    }

    if (normalizedContent[index] === '<' && !isEscaped(normalizedContent, index)) {
      if (htmlSuperscriptLinks) {
        const superscriptLink = matchHtmlSuperscriptLinkSource(normalizedContent, index)
        if (superscriptLink) {
          result += transport.create('html-superscript-link', JSON.stringify(superscriptLink.value))
          index = superscriptLink.end
          continue
        }
      }
      const inlineHtml = matchInlineHtml(normalizedContent.slice(index))
      if (inlineHtml) {
        result += transport.create('inline-html', inlineHtml)
        index += inlineHtml.length
        continue
      }
    }

    // Why: doc link encoding runs inside this loop so fenced code and backtick
    // spans have already been excluded from semantic preprocessing.
    if (
      normalizedContent[index] === '[' &&
      normalizedContent[index + 1] === '[' &&
      !isEscaped(normalizedContent, index)
    ) {
      const closingIndex = normalizedContent.indexOf(']]', index + 2)
      if (closingIndex !== -1) {
        const rawTarget = normalizedContent.slice(index + 2, closingIndex)
        const link = parseMarkdownDocLink(rawTarget)
        if (link && !isReservedRichMarkdownTransportBody(rawTarget)) {
          result += transport.create(
            'document-link',
            formatMarkdownDocLinkBody(link.target, link.alias)
          )
          index = closingIndex + 2
          continue
        }
      }
    }

    const nextChar = normalizedContent[index]
    result += nextChar
    isLineStart = nextChar === '\n'
    index += 1
  }

  return result
}

export {
  createRichMarkdownLiteral,
  createRawMarkdownHtmlInline,
  createRawMarkdownHtmlBlock
} from './raw-markdown-html-nodes'
