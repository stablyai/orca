// Keep existing word elements stable while streams append so only newly mounted words fade.

import type { Element, Root } from 'hast'
import { SPACELESS_SCRIPT_RANGES } from '../../../../shared/native-chat/transcript/native-chat-text-reveal'

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

function splitWords(node: Root | Element): void {
  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    const child = node.children[index]
    if (child.type === 'text') {
      node.children[index] = {
        type: 'element',
        tagName: 'span',
        properties: { dataWordGroup: '' },
        children: [{ type: 'text', value: child.value }]
      }
    } else if (
      child.type === 'element' &&
      !UNSPLIT_TAGS.has(child.tagName) &&
      !(Array.isArray(child.properties.className) && child.properties.className.includes('katex'))
    ) {
      splitWords(child)
    }
  }
}

export function rehypeWordFade(): (tree: Root) => void {
  return splitWords
}
