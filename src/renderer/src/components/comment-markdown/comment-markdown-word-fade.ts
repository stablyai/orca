// Only words in the fade window become elements; newly mounted ones fade in by CSS.

import type { Element, ElementContent, Root } from 'hast'
import { SPACELESS_SCRIPT_RANGES } from '../../../../shared/native-chat/transcript/row-content/native-chat-text-reveal'

/** Elements whose renderers read their text, or that are faded in as a whole. */
const UNSPLIT_TAGS = new Set(['a', 'code', 'pre', 'kbd', 'svg', 'math'])

/** Whitespace, one character of a script written without spaces, or a run of anything else. */
const WORD_PATTERN = new RegExp(
  `\\s+|[${SPACELESS_SCRIPT_RANGES}]|[^\\s${SPACELESS_SCRIPT_RANGES}]+`,
  'gu'
)

export function markdownWordTokens(value: string): { value: string; offset: number }[] {
  return Array.from(value.matchAll(WORD_PATTERN), (match) => ({
    value: match[0],
    offset: match.index
  }))
}

function textLength(node: ElementContent): number {
  if (node.type === 'text') {
    return node.value.length
  }
  return node.type === 'element'
    ? node.children.reduce((sum, child) => sum + textLength(child), 0)
    : 0
}

/** Every text node becomes a word group, so the groups keep their places while the window moves;
 *  each records where in its text the window starts. Text that plugins added has no position, so
 *  it is placed after what came before it. */
function splitWords(node: Root | Element, from: number, cursor: { at: number }): void {
  node.children.forEach((child, index) => {
    const start = child.position?.start.offset
    const end = child.position?.end.offset
    if (child.type === 'text') {
      const at = start ?? cursor.at
      cursor.at = end ?? at + child.value.length
      node.children[index] = {
        type: 'element',
        tagName: 'span',
        properties: {
          dataWordGroup: '',
          dataFadeFrom: Math.min(child.value.length, Math.max(0, from - at)),
          dataFadeOffset: at
        },
        children: [{ type: 'text', value: child.value }]
      }
      return
    }
    if (child.type !== 'element') {
      return
    }
    cursor.at = start ?? cursor.at
    if (
      !UNSPLIT_TAGS.has(child.tagName) &&
      !(Array.isArray(child.properties.className) && child.properties.className.includes('katex'))
    ) {
      splitWords(child, from, cursor)
    } else if (end === undefined) {
      cursor.at += textLength(child)
    }
    cursor.at = end ?? cursor.at
  })
}

/** Words from source offset `from` on fade in; text before it renders plain. */
export function rehypeWordFade({ from }: { from: number }): (tree: Root) => void {
  return (tree) => splitWords(tree, from, { at: 0 })
}
