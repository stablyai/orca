import { Plugin, TextSelection, type Transaction } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { promptLeafString, QUOTE_LINE, QUOTE_NODE } from './native-chat-prompt-document-text'

const lineText = (nodes: readonly ProseMirrorNode[]): string =>
  nodes.map(({ type, attrs, text }) => promptLeafString(type.name, attrs, text)).join('')

/**
 * True when Markdown continues an earlier blockquote into the chip at child `index` of block
 * `blockIndex`: a line in the run of non-blank lines directly above the chip's line is a quote
 * line. Reads the blocks upward only to the first blank line.
 */
function continuesBlockquote(doc: ProseMirrorNode, blockIndex: number, index: number): boolean {
  for (let at = blockIndex; at >= 0; at--) {
    const children = doc.child(at).content.content
    // A chip that starts its block has no text before it on its own line.
    if (at === blockIndex && index === 0) {
      continue
    }
    const lines = lineText(at === blockIndex ? children.slice(0, index) : children).split('\n')
    for (const line of lines.toReversed()) {
      if (line.trim() === '') {
        return false
      }
      if (QUOTE_LINE.test(line)) {
        return true
      }
    }
  }
  return false
}

/**
 * Keeps each quote chip a blockquote of its own in the text the agent gets.
 * A chip with text or a pill before it on its line starts a new line: a blockquote starts a line.
 * A chip line directly under a run of lines with a quote line gets a blank line above it:
 * Markdown otherwise continues that blockquote into the chip's. A chip after a chip ends in a
 * blank line already.
 */
export function layoutQuoteChips(state: { doc: ProseMirrorNode; tr: Transaction }): Transaction {
  const { doc, tr } = state
  const edits: { position: number; split: boolean; blankLine: boolean }[] = []
  doc.forEach((block, blockOffset, blockIndex) => {
    block.forEach((node, offset, index) => {
      if (node.type.name !== QUOTE_NODE || block.maybeChild(index - 1)?.type.name === QUOTE_NODE) {
        return
      }
      const position = blockOffset + 1 + offset
      const blankLine = continuesBlockquote(doc, blockIndex, index)
      if (index > 0 || blankLine) {
        edits.push({ position, split: index > 0, blankLine })
      }
    })
  })
  // From the end, so the positions still to change stay valid.
  for (const { position, split, blankLine } of edits.toReversed()) {
    if (split) {
      tr.split(position)
    }
    if (blankLine) {
      // Between the line before and the chip's line.
      tr.insert(split ? position + 1 : position - 1, doc.type.schema.nodes.paragraph.create())
    }
  }
  return tr
}

export const nativeChatQuoteLayout = new Plugin({
  appendTransaction: (transactions, _old, state) => {
    // Programmatic writes (preventUpdate) must keep the text they set.
    if (!transactions.some((tr) => tr.docChanged && !tr.getMeta('preventUpdate'))) {
      return null
    }
    const tr = layoutQuoteChips(state)
    const { selection } = state
    if (tr.docChanged && selection instanceof TextSelection) {
      // Text typed before a chip stays on the line above it.
      tr.setSelection(
        TextSelection.create(
          tr.doc,
          tr.mapping.map(selection.anchor, -1),
          tr.mapping.map(selection.head, -1)
        )
      )
    }
    return tr.docChanged ? tr : null
  }
})
