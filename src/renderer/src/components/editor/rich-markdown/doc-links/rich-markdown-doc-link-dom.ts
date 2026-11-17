import { mergeAttributes } from '@tiptap/core'
import type { DOMOutputSpec } from '@tiptap/pm/model'

export function renderRichMarkdownDocLinkHtml(
  node: { attrs: Record<string, unknown> },
  htmlAttributes: Record<string, unknown>
): DOMOutputSpec {
  const target = typeof node.attrs.target === 'string' ? node.attrs.target : ''
  const label = typeof node.attrs.label === 'string' ? node.attrs.label : null
  return [
    'span',
    mergeAttributes(htmlAttributes, {
      'data-doc-link-target': target,
      ...(label ? { 'data-doc-link-label': label } : {}),
      contenteditable: 'false',
      class: 'rich-markdown-doc-link'
    }),
    label ?? target
  ]
}
