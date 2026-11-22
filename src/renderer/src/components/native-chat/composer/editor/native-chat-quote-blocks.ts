import type { JSONContent } from '@tiptap/react'

/** A quote chip: a quote "Add to chat" took. */
export const QUOTE_NODE = 'nativeChatQuote'

// Holds the place of text with other pills: not a quote line and not blank.
const KEPT_LINE = 'x'

const tokenOf = (node: JSONContent): string => String(node.attrs?.token ?? '')

/** The text of text and quote chips; null when there are other nodes. */
function plainText(nodes: readonly JSONContent[]): string | null {
  let text = ''
  for (const node of nodes) {
    if (node.type === 'text') {
      text += node.text ?? ''
    } else if (node.type === QUOTE_NODE) {
      text += tokenOf(node)
    } else {
      return null
    }
  }
  return text
}

const blockKey = (block: JSONContent): string =>
  JSON.stringify((block.content ?? []).map((child) => [child.type, child.text, child.attrs]))

/**
 * The blocks with the quote chips that the parser reads from their text. The text stays the same.
 * Text with other pills stays as it is, after the chips that start its line.
 * Returns the changed blocks `first`..`last` and what replaces them, or null when nothing changes.
 * `parse` reads text as the composer does: promptTextContent.
 */
export function reparseQuoteBlocks(
  blocks: readonly JSONContent[],
  parse: (text: string) => JSONContent
): { first: number; last: number; blocks: JSONContent[] } | null {
  // The content after its chips of each block with other pills, by the block's last line.
  const kept = new Map<number, JSONContent[]>()
  let line = -1
  const text = blocks
    .map((block) => {
      const content = block.content ?? []
      let chips = 0
      while (content[chips]?.type === QUOTE_NODE) {
        chips++
      }
      const rest = plainText(content.slice(chips))
      const blockText = content.slice(0, chips).map(tokenOf).join('') + (rest ?? KEPT_LINE)
      line += blockText.split('\n').length
      if (rest === null) {
        kept.set(line, content.slice(chips))
      }
      return blockText
    })
    .join('\n')
  line = -1
  const next = (parse(text).content ?? []).map((paragraph): JSONContent => {
    const chips = (paragraph.content ?? []).filter((node) => node.type === QUOTE_NODE)
    line += chips.reduce((lines, chip) => lines + tokenOf(chip).split('\n').length - 1, 1)
    const rest = kept.get(line)
    return rest ? { ...paragraph, content: [...chips, ...rest] } : paragraph
  })
  let first = 0
  while (
    first < blocks.length &&
    first < next.length &&
    blockKey(blocks[first]) === blockKey(next[first])
  ) {
    first++
  }
  let end = 0
  while (
    end < blocks.length - first &&
    end < next.length - first &&
    blockKey(blocks[blocks.length - 1 - end]) === blockKey(next[next.length - 1 - end])
  ) {
    end++
  }
  return first === blocks.length && first === next.length
    ? null
    : { first, last: blocks.length - 1 - end, blocks: next.slice(first, next.length - end) }
}

/** A stored document with the chips its text has. */
export function withQuoteChipsParsed(
  document: JSONContent,
  parse: (text: string) => JSONContent
): JSONContent {
  const content = document.content ?? []
  const result = reparseQuoteBlocks(content, parse)
  return result
    ? {
        ...document,
        content: [
          ...content.slice(0, result.first),
          ...result.blocks,
          ...content.slice(result.last + 1)
        ]
      }
    : document
}
