import { mergeAttributes } from '@tiptap/core'
import type { DOMOutputSpec, Node as ProseMirrorNode, TagParseRule } from '@tiptap/pm/model'
import type { RichMarkdownSourceKind } from './rich-markdown-source-transport'

// Preserve authored break spelling; native hardBreak serializes to a space in table cells.
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
  // Clipboard markers may preserve break syntax only.
  return value && isHtmlLineBreak(value) ? value : '<br>'
}

function nodeValue(node: ProseMirrorNode): string {
  return typeof node.attrs.value === 'string' ? node.attrs.value : ''
}

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
    // Parse preserved breaks before StarterKit's unmarked hardBreak rule.
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
