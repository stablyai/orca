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

/** Source offsets of selected fading words; their groups keep their word elements as the window moves. */
export type MarkdownFadeHold = { from: number; to: number }

type WordFade = { from: number; base: number; hold?: MarkdownFadeHold }

/** Every text node becomes a word group, so the groups keep their places while the window moves;
 *  each records where in its text the window starts. Text that plugins added has no position, so
 *  it is placed after what came before it. */
function splitWords(node: Root | Element, fade: WordFade, cursor: { at: number }): void {
  const { from, base, hold } = fade
  node.children.forEach((child, index) => {
    const start = child.position?.start.offset
    const end = child.position?.end.offset
    if (child.type === 'text') {
      const at = start ?? cursor.at
      cursor.at = end ?? at + child.value.length
      const held = hold && at < hold.to && at + child.value.length > hold.from
      const groupFrom = held ? Math.min(from, hold.from) : from
      node.children[index] = {
        type: 'element',
        tagName: 'span',
        properties: {
          dataWordGroup: '',
          dataFadeFrom: Math.min(child.value.length, Math.max(0, groupFrom - at)),
          dataFadeOffset: base + at
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
      splitWords(child, fade, cursor)
    } else if (end === undefined) {
      cursor.at += textLength(child)
    }
    cursor.at = end ?? cursor.at
  })
}

/** Words from block offset `from` on fade in; text before it renders plain, except in groups that
 *  `hold` reaches. Groups record their offsets in the whole content, which starts `base` earlier. */
export function rehypeWordFade(fade: WordFade): (tree: Root) => void {
  return (tree) => splitWords(tree, fade, { at: 0 })
}
