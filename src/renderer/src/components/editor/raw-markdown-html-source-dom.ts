import { mergeAttributes } from '@tiptap/core'
import type { DOMOutputSpec, Node as ProseMirrorNode, TagParseRule } from '@tiptap/pm/model'
import type { RichMarkdownSourceKind } from './rich-markdown-source-transport'

const HTML_LINE_BREAK_VALUE_ATTR = 'data-raw-markdown-html-value'

type RawMarkdownSourceDomConfig = {
  inline: boolean
  kind: RichMarkdownSourceKind
  marker: string
  className?: string
}

export function isHtmlLineBreak(value: string): boolean {
  return /^<br\s*\/?>$/i.test(value.trim())
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
    // Preserve source spelling without accepting forged clipboard Markdown.
    rules.push({
      tag: `br[${config.marker}]`,
      priority: 100,
      getAttrs: (element: HTMLElement) => {
        const value = element.getAttribute(HTML_LINE_BREAK_VALUE_ATTR)
        return { value: value && isHtmlLineBreak(value) ? value : '<br>' }
      }
    })
  }
  return rules
}

export function renderRawMarkdownSourceHtml(
  config: RawMarkdownSourceDomConfig,
  attributes: Record<string, unknown>,
  node: ProseMirrorNode
): DOMOutputSpec {
  const value = typeof node.attrs.value === 'string' ? node.attrs.value : ''
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
