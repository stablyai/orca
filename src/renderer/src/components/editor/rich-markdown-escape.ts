import { Node } from '@tiptap/core'

/**
 * Carries a backslash escape through the document. The parser drops marked's
 * `escape` token because nothing handles it, so `Veri\*Factu` loses both the
 * backslash and the asterisk. Holding the original bytes on the node is what
 * keeps the escape stable: emitting the bare character alone lets the next
 * parse read `\_x\_` back as emphasis.
 */
export const RichMarkdownEscape = Node.create({
  name: 'richMarkdownEscape',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      source: { default: '', rendered: false },
      text: { default: '', rendered: false }
    }
  },

  // Why: ProseMirror reads a leaf node's text through the schema spec, not through
  // renderText, so copy and textContent would otherwise drop the character.
  extendNodeSchema() {
    return {
      leafText: (node: { attrs?: Record<string, unknown> }) => String(node.attrs?.text ?? '')
    }
  },

  markdownTokenName: 'escape',
  parseMarkdown: (token, helpers) => {
    const source = typeof token.raw === 'string' ? token.raw : ''
    const text = typeof token.text === 'string' ? token.text : ''
    if (!source) {
      return []
    }
    return helpers.createNode('richMarkdownEscape', { source, text })
  },
  renderMarkdown: (node) => String(node.attrs?.source ?? ''),
  renderText: ({ node }) => String(node.attrs?.text ?? ''),

  parseHTML() {
    return [{ tag: 'span[data-rich-markdown-escape]' }]
  },

  renderHTML({ node }) {
    return ['span', { 'data-rich-markdown-escape': '' }, String(node.attrs?.text ?? '')]
  }
})
