import { Node, mergeAttributes } from '@tiptap/core'
import { isEditableDetailsHtmlBlock, matchDetailsHtmlBlock } from './details-markdown-html'
import { formatMarkdownDocLinkBody, parseMarkdownDocLink } from './markdown-doc-links'
import { normalizeMarkdownReferenceLinks } from './markdown-reference-link-normalization'
import { createMarkdownCodeSpanScanner } from './markdown-code-span-scanner'
import {
  createMarkdownFenceTracker,
  findMarkdownLineEnd,
  skipMarkdownLineBreak
} from './markdown-fence-scanner'
import type {
  RichMarkdownEditorCodec,
  RichMarkdownSourceKind,
  RichMarkdownSourceTransport
} from './rich-markdown-source-transport'
import {
  isReservedRichMarkdownTransportBody,
  skipInlineTransportStartScan
} from './rich-markdown-source-transport'
import { matchHtmlSuperscriptLinkSource } from './rich-markdown-html-superscript-link-source'

const INLINE_HTML_PATTERN = /^<!--[\s\S]*?-->|^<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>/

function isEscaped(content: string, index: number): boolean {
  let backslashCount = 0
  for (let i = index - 1; i >= 0 && content[i] === '\\'; i -= 1) {
    backslashCount += 1
  }
  return backslashCount % 2 === 1
}

// A lone CR breaks a line for marked, so it starts one here too.
function isAtLineStart(content: string, index: number): boolean {
  if (index === 0) {
    return true
  }
  const previous = content.charCodeAt(index - 1)
  return previous === 10 || (previous === 13 && content.charCodeAt(index) !== 10)
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
  const line = content.slice(start, findMarkdownLineEnd(content, start))
  return isLineOnlyHtml(line) ? line : null
}

export function encodeRawMarkdownHtmlForRichEditor(
  content: string,
  codec: RichMarkdownEditorCodec,
  { htmlSuperscriptLinks = false }: { htmlSuperscriptLinks?: boolean } = {}
): string {
  const normalizedContent = normalizeMarkdownReferenceLinks(content)
  const lastCommentClose = normalizedContent.lastIndexOf('-->')
  const { transport } = codec
  let index = 0
  const fence = createMarkdownFenceTracker()
  const spans = createMarkdownCodeSpanScanner(normalizedContent)
  let result = ''
  while (index < normalizedContent.length) {
    const isLineStart = isAtLineStart(normalizedContent, index)
    if (isLineStart) {
      const lineEnd = findMarkdownLineEnd(normalizedContent, index)
      // Consume the fence line so a closer cannot become an inline-code opener.
      if (fence.consume(normalizedContent.slice(index, lineEnd))) {
        const end = skipMarkdownLineBreak(normalizedContent, lineEnd)
        result += normalizedContent.slice(index, end)
        index = end
        continue
      }
    }

    if (fence.insideFence) {
      result += normalizedContent[index]
      index += 1
      continue
    }

    if (normalizedContent[index] === '`') {
      const spanEnd = spans.findSpanEnd(index)
      if (spanEnd !== null) {
        result += normalizedContent.slice(index, spanEnd)
        index = spanEnd
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
      // An unterminated comment cannot match; later tags must still be encoded.
      const inlineHtml =
        normalizedContent.startsWith('<!--', index) && index + 4 > lastCommentClose
          ? null
          : (normalizedContent.slice(index).match(INLINE_HTML_PATTERN)?.[0] ?? null)
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

    result += normalizedContent[index]
    index += 1
  }

  return result
}

export function createRichMarkdownLiteral(transport: RichMarkdownSourceTransport) {
  return createRawSourceNode({
    name: 'richMarkdownLiteral',
    kind: 'literal',
    inline: true,
    transport,
    marker: 'data-rich-markdown-literal'
  })
}

export function createRawMarkdownHtmlInline(transport: RichMarkdownSourceTransport) {
  return createRawSourceNode({
    name: 'rawMarkdownHtmlInline',
    kind: 'inline-html',
    inline: true,
    transport,
    marker: 'data-raw-markdown-html-inline',
    className: 'raw-markdown-html-inline'
  })
}

function createRawSourceNode({
  name,
  kind,
  inline,
  transport,
  marker,
  className
}: {
  name: string
  kind: RichMarkdownSourceKind
  inline: boolean
  transport: RichMarkdownSourceTransport
  marker: string
  className?: string
}) {
  return Node.create({
    name,
    inline,
    group: inline ? 'inline' : 'block',
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        value: {
          default: '',
          rendered: false
        }
      }
    },

    // Why: converting embedded HTML tags into placeholder tokens before the
    // markdown parser runs keeps marked's built-in paragraph tokenization intact
    // while still letting Orca round-trip the raw markup verbatim.
    markdownTokenName: name,
    markdownTokenizer: {
      name,
      level: inline ? 'inline' : 'block',
      start: inline ? skipInlineTransportStartScan : transport.startFor(kind),
      tokenize(src) {
        const matched = transport.match(src, kind)
        if (!matched) {
          return undefined
        }

        return {
          type: name,
          raw: matched.raw,
          text: matched.value,
          block: !inline
        }
      }
    },
    parseMarkdown: (token, helpers) => {
      if (token.type !== name) {
        return []
      }

      return helpers.createNode(name, {
        value: typeof token.text === 'string' ? token.text : ''
      })
    },
    renderMarkdown: (node) => (typeof node.attrs?.value === 'string' ? node.attrs.value : ''),
    renderText: ({ node }) => (typeof node.attrs.value === 'string' ? node.attrs.value : ''),

    parseHTML() {
      return [
        {
          tag: `${inline ? 'span' : 'div'}[${marker}]`,
          getAttrs: (element: HTMLElement) => ({ value: element.textContent ?? '' })
        }
      ]
    },

    renderHTML({ HTMLAttributes, node }) {
      const value = typeof node.attrs.value === 'string' ? node.attrs.value : ''
      return [
        inline ? 'span' : 'div',
        mergeAttributes(HTMLAttributes, {
          [marker]: '',
          contenteditable: 'false',
          class: className
        }),
        inline ? value : ['pre', value]
      ]
    }
  })
}

export function createRawMarkdownHtmlBlock(transport: RichMarkdownSourceTransport) {
  return createRawSourceNode({
    name: 'rawMarkdownHtmlBlock',
    kind: 'block-html',
    inline: false,
    transport,
    marker: 'data-raw-markdown-html-block',
    className: 'raw-markdown-html-block'
  })
}
