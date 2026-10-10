// Wraps each word of rendered markdown in its own element, so a word can fade in
// as it is appended. Words already rendered keep their element, so appending
// text mounts only the new ones.

import type { Element, Root } from 'hast'

/** Elements whose renderers read their text, or that are faded in as a whole. */
const UNSPLIT_TAGS = new Set(['a', 'code', 'pre', 'kbd', 'svg', 'math'])

/** Scripts written without spaces, where each character is its own word. */
const SPACELESS_SCRIPT_RANGES = String.raw`\u2e80-\ud7ff\uf900-\uffef`
const SPACELESS_SCRIPT_CHAR = new RegExp(`[${SPACELESS_SCRIPT_RANGES}]`, 'u')

/** Shared with whatever paces the text these words are drawn from, so both end words alike. */
export function isSpacelessScriptChar(char: string): boolean {
  return SPACELESS_SCRIPT_CHAR.test(char)
}

/** Whitespace, one character of such a script, or a run of anything else. */
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
  // Only text is replaced, so an element's children stay element content.
  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    const child = node.children[index]
    if (child.type === 'text') {
      node.children[index] = {
        type: 'element',
        tagName: 'span',
        properties: { dataWordGroup: '' },
        children: [{ type: 'text', value: child.value }]
      }
    } else if (child.type === 'element' && !UNSPLIT_TAGS.has(child.tagName)) {
      splitWords(child)
    }
  }
}

export function rehypeWordFade(): (tree: Root) => void {
  return splitWords
}
