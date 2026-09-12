import { Mark } from '@tiptap/core'

const SOURCE_ATTRIBUTE = 'data-orca-markdown-escape-source'
const MARKER_ATTRIBUTE = 'data-rich-markdown-escape'

/**
 * Backslashes the escape carries ahead of its character. `source` is the escape's
 * original bytes and its last code unit is the character itself, which the marked
 * text node already holds, so only the run before it belongs to the prefix.
 */
function escapePrefix(node: { attrs?: Record<string, unknown> }): string {
  const source = String(node.attrs?.source ?? '')
  const prefix = source.slice(0, -1)
  return /^\\+$/.test(prefix) ? prefix : '\\'
}

/**
 * Carries a backslash escape through the document. The parser drops marked's
 * `escape` token because nothing handles it, so `Veri\*Factu` loses both the
 * backslash and the asterisk. Holding the original bytes on a mark is what keeps
 * the escape stable: emitting the bare character alone lets the next parse read
 * `\_x\_` back as emphasis. A mark rather than a node because the serializer's
 * boundary walk carries marks across text nodes only, so an inline node between
 * two marked runs closes and reopens the surrounding link or emphasis.
 */
export const RichMarkdownEscape = Mark.create({
  name: 'richMarkdownEscape',
  inclusive: false,
  // Why: two adjacent escapes keep separate source bytes, so merging them would
  // emit one character's backslash for both.
  spanning: false,

  addAttributes() {
    return {
      source: {
        default: '',
        parseHTML: (element) => element.getAttribute(SOURCE_ATTRIBUTE) ?? '',
        renderHTML: (attributes) => ({ [SOURCE_ATTRIBUTE]: String(attributes.source ?? '') })
      }
    }
  },

  markdownTokenName: 'escape',
  parseMarkdown: (token, helpers) => {
    const source = typeof token.raw === 'string' ? token.raw : ''
    const text = typeof token.text === 'string' ? token.text : ''
    if (!source || !text) {
      return []
    }
    return helpers.applyMark('richMarkdownEscape', [helpers.createTextNode(text)], { source })
  },
  // Why: the serializer derives a mark's delimiters by rendering it around a
  // placeholder and splitting there, so the backslash has to precede the children
  // rather than replace them.
  renderMarkdown: (node, helpers) => `${escapePrefix(node)}${helpers.renderChildren(node)}`,

  parseHTML() {
    return [{ tag: `span[${MARKER_ATTRIBUTE}]` }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, [MARKER_ATTRIBUTE]: '' }, 0]
  }
})
