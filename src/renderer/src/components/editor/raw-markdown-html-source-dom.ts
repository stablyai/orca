import { mergeAttributes } from '@tiptap/core'
import type { DOMOutputSpec, Node as ProseMirrorNode, TagParseRule } from '@tiptap/pm/model'
import type { RichMarkdownSourceKind } from './rich-markdown-source-transport'

// Why: preserves the exact authored <br> spelling on the rendered break node so
// renderMarkdown can round-trip it verbatim instead of a native hardBreak, which
// serializes to a space and silently drops the tag inside Markdown table cells.
const HTML_LINE_BREAK_VALUE_ATTR = 'data-raw-markdown-html-value'

type RawMarkdownSourceDomConfig = {
  inline: boolean
  kind: RichMarkdownSourceKind
  marker: string
  className?: string
}

function isHtmlLineBreak(value: string): boolean {
  return /^<br\s*\/?>$/i.test(value.trim())
}

function parsedHtmlLineBreakValue(element: HTMLElement): string {
  const value = element.getAttribute(HTML_LINE_BREAK_VALUE_ATTR)
  // Why: DOM input can come from the clipboard, so only trusted break syntax
  // may become hidden Markdown source through the internal preservation marker.
  return value && isHtmlLineBreak(value) ? value : '<br>'
}

function nodeValue(node: ProseMirrorNode): string {
  return typeof node.attrs.value === 'string' ? node.attrs.value : ''
}

// Why: only inline raw HTML can carry a <br>, so line-break rendering is scoped
// to that node kind; literal envelopes and block HTML stay verbatim.
function rendersLineBreaks(config: RawMarkdownSourceDomConfig): boolean {
  return config.inline && config.kind === 'inline-html'
}

export function rawMarkdownSourceParseRules(config: RawMarkdownSourceDomConfig): TagParseRule[] {
  const rules: TagParseRule[] = [
    {
      tag: `${config.inline ? 'span' : 'div'}[${config.marker}]`,
      getAttrs: (element: HTMLElement) => ({ value: element.textContent ?? '' })
    }
  ]
  if (rendersLineBreaks(config)) {
    // Why: a <br> renders as a real break element (see renderHTML), so it must
    // round-trip back to this node rather than StarterKit's hardBreak; the marker
    // attribute and priority keep it ahead of hardBreak's bare `br` rule.
    rules.push({
      tag: `br[${config.marker}]`,
      priority: 100,
      getAttrs: (element: HTMLElement) => ({ value: parsedHtmlLineBreakValue(element) })
    })
  }
  return rules
}

export function renderRawMarkdownSourceHtml(
  config: RawMarkdownSourceDomConfig,
  attributes: Record<string, unknown>,
  node: ProseMirrorNode
): DOMOutputSpec {
  const value = nodeValue(node)
  // Why: <br> is the one inline HTML tag with line-break semantics the rich
  // surface can honor directly. Render it as an actual break so it displays
  // correctly where blank-line breaks are impossible (e.g. Markdown table cells).
  if (rendersLineBreaks(config) && isHtmlLineBreak(value)) {
    return [
      'br',
      mergeAttributes(attributes, { [config.marker]: '', [HTML_LINE_BREAK_VALUE_ATTR]: value })
    ]
  }
  return [
    config.inline ? 'span' : 'div',
    mergeAttributes(attributes, {
      [config.marker]: '',
      contenteditable: 'false',
      class: config.className
    }),
    config.inline ? value : ['pre', value]
  ]
}
