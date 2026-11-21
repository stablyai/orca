import { Plugin, TextSelection, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
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

/**
 * A gap: the empty line directly above a chip line. It shows no line, as in the sent message. The
 * text keeps the blank line that "Add to chat" writes, so the agent gets the same text.
 */
function isQuoteGap(doc: ProseMirrorNode, index: number): boolean {
  return (
    doc.maybeChild(index)?.content.size === 0 &&
    doc.maybeChild(index + 1)?.firstChild?.type.name === QUOTE_NODE
  )
}

function quoteGapDecorations(doc: ProseMirrorNode): DecorationSet {
  const gaps: Decoration[] = []
  doc.forEach((block, offset, index) => {
    if (isQuoteGap(doc, index)) {
      gaps.push(
        Decoration.node(offset, offset + block.nodeSize, {
          'data-native-chat-quote-gap': '',
          'aria-hidden': 'true',
          class: 'h-0 overflow-hidden'
        })
      )
    }
  })
  return DecorationSet.create(doc, gaps)
}

/** The caret place beside gap `gap`: the end of the line above it when `back`, else the chip line's start. */
function pastGap(doc: ProseMirrorNode, gap: number, back: boolean): number {
  let start = 1
  for (let index = 0; index < gap; index++) {
    start += doc.child(index).nodeSize
  }
  return back && gap > 0 ? start - 2 : start + doc.child(gap).nodeSize
}

/**
 * Arrows, Backspace and Delete next to a gap act as if the gap were not there. Backspace and Delete
 * change no text there, as next to a chip line with no gap: a chip always starts its line.
 */
export function quoteGapKey(
  view: EditorView,
  key: 'Backspace' | 'Delete' | 'ArrowLeft' | 'ArrowRight'
): boolean {
  const { selection, doc } = view.state
  const { $from } = selection
  const back = key === 'Backspace' || key === 'ArrowLeft'
  const gap = $from.index(0) + (back ? -1 : 1)
  const atEdge = $from.parentOffset === (back ? 0 : $from.parent.content.size)
  if (!selection.empty || $from.depth !== 1 || !atEdge || !isQuoteGap(doc, gap)) {
    return false
  }
  if (key !== 'Delete') {
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(doc, pastGap(doc, gap, back)))
        .scrollIntoView()
    )
  }
  return true
}

export const nativeChatQuoteLayout = new Plugin({
  props: { decorations: (state) => quoteGapDecorations(state.doc) },
  appendTransaction: (transactions, old, state) => {
    // Programmatic writes (preventUpdate) must keep the text they set.
    const layout = transactions.some((tr) => tr.docChanged && !tr.getMeta('preventUpdate'))
      ? layoutQuoteChips(state)
      : null
    const tr = layout?.docChanged ? layout : null
    const { selection } = state
    if (tr && selection instanceof TextSelection) {
      // Text typed before a chip stays on the line above it.
      tr.setSelection(
        TextSelection.create(
          tr.doc,
          tr.mapping.map(selection.anchor, -1),
          tr.mapping.map(selection.head, -1)
        )
      )
    }
    // No caret move rests on a gap: an up arrow or a click goes on past it.
    const caret = (tr ?? state).selection
    const doc = tr?.doc ?? state.doc
    if (!caret.empty || caret.$from.depth !== 1 || !isQuoteGap(doc, caret.$from.index(0))) {
      return tr
    }
    const back = caret.from < old.selection.from
    return (tr ?? state.tr).setSelection(
      TextSelection.create(doc, pastGap(doc, caret.$from.index(0), back))
    )
  }
})
