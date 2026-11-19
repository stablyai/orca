// Only words in the fade window become elements; newly mounted ones fade in by CSS.

import type { Element, Root } from 'hast'
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

/** Every text node becomes a word group, so the groups keep their places while the window moves;
 *  each records where in its text the window starts. */
function splitWords(node: Root | Element, from: number): void {
  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    const child = node.children[index]
    if (child.type === 'text') {
      const start = child.position?.start.offset
      if (start === undefined) {
        continue
      }
      node.children[index] = {
        type: 'element',
        tagName: 'span',
        properties: {
          dataWordGroup: '',
          dataFadeFrom: Math.min(child.value.length, Math.max(0, from - start)),
          dataFadeOffset: start
        },
        children: [{ type: 'text', value: child.value }]
      }
    } else if (
      child.type === 'element' &&
      !UNSPLIT_TAGS.has(child.tagName) &&
      !(Array.isArray(child.properties.className) && child.properties.className.includes('katex'))
    ) {
      splitWords(child, from)
    }
  }
}

/** Words from source offset `from` on fade in; text before it renders plain. */
export function rehypeWordFade({ from }: { from: number }): (tree: Root) => void {
  return (tree) => splitWords(tree, from)
}
