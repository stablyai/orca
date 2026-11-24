import type { Slice } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { promptTextContent } from './native-chat-prompt-document-text'
import { reparseQuoteBlocks } from './native-chat-quote-blocks'

/**
 * Makes the quote chips of the document equal to what the composer parser reads from its text.
 * The text stays the same, so text offsets stay valid. Only the changed blocks are replaced.
 * Why: a programmatic write changes the text a chip sends; the chip must show that text.
 */
export function reparseQuoteChips(tr: Transaction): void {
  const { doc } = tr
  const blocks = Array.from({ length: doc.childCount }, (_, index) => doc.child(index))
  const result = reparseQuoteBlocks(
    blocks.map((block) => block.toJSON()),
    promptTextContent
  )
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
