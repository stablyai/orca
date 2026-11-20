import type { JSONContent } from '@tiptap/react'
import type { Slice } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { promptTextContent, QUOTE_NODE } from './native-chat-prompt-document-text'

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
 */
export function reparseQuoteBlocks(
  blocks: readonly JSONContent[]
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
  const next = (promptTextContent(text).content ?? []).map((paragraph): JSONContent => {
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
export function withQuoteChipsParsed(document: JSONContent): JSONContent {
  const content = document.content ?? []
  const result = reparseQuoteBlocks(content)
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

/**
 * Makes the quote chips of the document equal to what the composer parser reads from its text.
 * The text stays the same, so text offsets stay valid. Only the changed blocks are replaced.
 * Why: a programmatic write changes the text a chip sends; the chip must show that text.
 */
export function reparseQuoteChips(tr: Transaction): void {
  const { doc } = tr
  const blocks = Array.from({ length: doc.childCount }, (_, index) => doc.child(index))
  const result = reparseQuoteBlocks(blocks.map((block) => block.toJSON()))
  if (!result) {
    return
  }
  const start = blocks.slice(0, result.first).reduce((size, block) => size + block.nodeSize, 0)
  const end = blocks
    .slice(result.first, result.last + 1)
    .reduce((size, block) => size + block.nodeSize, start)
  tr.replaceWith(
    start,
    end,
    result.blocks.map((block) => doc.type.schema.nodeFromJSON(block))
  )
}

/** Replaces `from`..`to` with `slice` as a programmatic write, and gives the text its chips. */
export function replacePromptText(tr: Transaction, from: number, to: number, slice: Slice): void {
  tr.replaceRange(from, to, slice)
  reparseQuoteChips(tr)
  tr.setMeta('preventUpdate', true)
}
