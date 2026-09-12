import { Mark } from '@tiptap/core'
import { createMarkBoundaryWalkExtension } from './rich-markdown-mark-boundary-walk'
import type { MarkdownNodeLike } from './rich-markdown-mark-boundary-walk'

export const ESCAPE_MARK_NAME = 'richMarkdownEscape'

const SOURCE_ATTRIBUTE = 'data-orca-markdown-escape-source'
const MARKER_ATTRIBUTE = 'data-rich-markdown-escape'

function escapeMarkOf(
  node: MarkdownNodeLike
): { type?: string; attrs?: Record<string, unknown> } | undefined {
  if (node?.type !== 'text') {
    return undefined
  }
  return (node.marks ?? []).find(
    (mark): mark is { type?: string; attrs?: Record<string, unknown> } =>
      typeof mark !== 'string' && mark?.type === ESCAPE_MARK_NAME
  )
}

/**
 * The escape's original bytes, which carry one backslash per escaped character.
 * A text node whose mark lost its attrs falls back to escaping what it holds.
 */
function escapeSource(node: MarkdownNodeLike, mark: { attrs?: Record<string, unknown> }): string {
  const source = String(mark.attrs?.source ?? '')
  const text = node.text ?? ''
  return source || Array.from(text, (character) => `\\${character}`).join('')
}

/**
 * Rewrites each escaped text node to its original bytes and joins runs that sit
 * next to each other. The boundary walk keys active marks by type and compares
 * mark sets by type alone, so consecutive escape marks read as one continuous run
 * and only the first one's delimiter is emitted. Carrying every backslash in the
 * text rather than in a delimiter is what keeps each escape its own.
 */
export function expandEscapeSources(nodes: MarkdownNodeLike[]): MarkdownNodeLike[] {
  const expanded: MarkdownNodeLike[] = []
  for (const node of nodes) {
    const mark = escapeMarkOf(node)
    if (!mark) {
      expanded.push(node)
      continue
    }
    const text = escapeSource(node, mark)
    const previous = expanded.at(-1)
    if (previous && escapeMarkOf(previous)) {
      expanded[expanded.length - 1] = { ...previous, text: (previous.text ?? '') + text }
      continue
    }
    expanded.push({ ...node, text })
  }
  return expanded
}

/**
 * Carries a backslash escape through the document. The parser drops marked's
 * `escape` token because nothing handles it, so `Veri\*Factu` loses both the
 * backslash and the asterisk. Holding the original bytes on a mark is what keeps
 * the escape stable: emitting the bare character alone lets the next parse read
 * `\_x\_` back as emphasis. A mark rather than a node because the serializer's
 * boundary walk carries marks across text nodes only, so an inline node between
 * two marked runs closes and reopens the surrounding link or emphasis.
 * `expandEscapeSources` puts the backslashes back on the way out.
 */
export const RichMarkdownEscape = Mark.create({
  name: ESCAPE_MARK_NAME,
  inclusive: false,
  // Why: two adjacent escapes keep separate source bytes, so merging them in the
  // document would lose one character's backslash.
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
    return helpers.applyMark(ESCAPE_MARK_NAME, [helpers.createTextNode(text)], { source })
  },
  // Why: the escaped bytes travel in the text node, so the mark itself adds no
  // delimiter; rendering no placeholder is what makes the walk emit none.
  renderMarkdown: (node, helpers) => helpers.renderChildren(node),

  parseHTML() {
    return [{ tag: `span[${MARKER_ATTRIBUTE}]` }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, [MARKER_ATTRIBUTE]: '' }, 0]
  }
})

/** Puts each escape's backslashes back into the text the walk renders. */
export const RichMarkdownEscapeSources = createMarkBoundaryWalkExtension({
  name: 'richMarkdownEscapeSources',
  createSession: () => ({ mask: expandEscapeSources, restore: (markdown) => markdown })
})
