import type { Editor } from '@tiptap/core'
import { Fragment, type Node as PmNode } from '@tiptap/pm/model'

/**
 * Why: the `marked` parser (with `breaks: false`, the default) treats consecutive
 * lines without a blank separator as a single paragraph with literal `\n` characters
 * in the text content (e.g. "Line one\nLine two\nLine three").  These `\n` chars are
 * invisible in the rendered HTML (normal `white-space` collapsing), but they cause
 * the block-cut handler to remove the entire multi-line paragraph on Cmd+X instead
 * of just one logical line.
 *
 * This function normalises the ProseMirror document by splitting any paragraph whose
 * text nodes contain `\n` into separate paragraph nodes — one per line.  Inline marks
 * (bold, italic, links, etc.) are preserved on each resulting paragraph.  This is
 * structurally correct for the editing model: each visual line becomes its own block,
 * so the cut handler (and all other block-level operations) work on a per-line basis.
 */
export function normalizeSoftBreaks(editor: Editor): void {
  const { doc, schema, tr } = editor.state
  const paragraphType = schema.nodes.paragraph
  if (!paragraphType) {
    return
  }

  // Collect replacements in reverse document order so earlier offsets stay valid.
  const replacements: { from: number; to: number; paragraphs: Fragment[] }[] = []

  doc.forEach((node, offset) => {
    if (node.type !== paragraphType) {
      return
    }
    if (!node.textContent.includes('\n')) {
      return
    }

    // Build an array of Fragment contents — one per output paragraph.
    // We walk the paragraph's inline content, splitting text nodes on `\n`
    // while preserving marks on every piece.
    const lines: Fragment[] = []
    let currentNodes: PmNode[] = []

    node.content.forEach((child) => {
      if (!child.isText || !child.text?.includes('\n')) {
        currentNodes.push(child)
        return
      }

      // Split this text node on `\n`.  Each segment inherits the original marks.
      const parts = child.text!.split('\n')
      parts.forEach((part, i) => {
        if (i > 0) {
          // Flush currentNodes into a completed line.
          lines.push(Fragment.from(currentNodes))
          currentNodes = []
        }
        if (part.length > 0) {
          currentNodes.push(schema.text(part, child.marks))
        }
      })
    })

    // Flush the last accumulated line.
    lines.push(Fragment.from(currentNodes))

    // Only replace if we actually split into multiple paragraphs.
    if (lines.length <= 1) {
      return
    }

    replacements.push({
      from: offset,
      to: offset + node.nodeSize,
      paragraphs: lines
    })
  })

  if (replacements.length === 0) {
    return
  }

  // Apply replacements in reverse order to preserve positions.
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { from, to, paragraphs } = replacements[i]
    const newNodes = paragraphs.map((content) => paragraphType.create(null, content))
    tr.replaceWith(from, to, newNodes)
  }

  // Why: this normalization is a structural housekeeping step, not a user edit.
  // addToHistory: false prevents it from polluting the undo stack.
  editor.view.dispatch(tr.setMeta('addToHistory', false))
}
