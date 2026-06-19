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
 * text nodes contain `\n` into separate paragraph nodes — one per line — and by
 * giving empty parsed list items a paragraph caret target. Inline marks (bold,
 * italic, links, etc.) are preserved on each resulting paragraph. This is
 * structurally correct for the editing model: each visual line becomes its own block,
 * so the cut handler (and all other block-level operations) work on a per-line basis.
 */
export function normalizeSoftBreaks(editor: Editor): void {
  // Why: we read from editor.view.state (not editor.state) so that the doc
  // we traverse and the transaction we later create share the same base state.
  // After setContent(), editor.state can be stale (last React render), while
  // editor.view.state always reflects the latest document.
  const { doc, schema } = editor.view.state
  const paragraphType = schema.nodes.paragraph
  if (!paragraphType) {
    return
  }

  // Collect replacements across the entire document tree, not just top-level nodes.
  // Why: doc.forEach only iterates top-level children, so paragraphs nested inside
  // blockquotes, table cells, or other container nodes would be missed.
  // doc.descendants walks every node at every depth and provides absolute positions.
  const replacements: (
    | { from: number; to: number; kind: 'soft-break-paragraphs'; paragraphs: Fragment[] }
    | { from: number; to: number; kind: 'empty-list-item'; node: PmNode }
  )[] = []

  doc.descendants((node, pos) => {
    if (node.type.name === 'listItem' && node.childCount === 0) {
      // Why: marked parses `3. ` immediately before a heading as a list item
      // with no paragraph. It renders a marker but has no editable caret target.
      replacements.push({
        from: pos,
        to: pos + node.nodeSize,
        kind: 'empty-list-item',
        node: node.type.create(node.attrs, paragraphType.create(), node.marks)
      })
      return false
    }

    if (node.type !== paragraphType) {
      return true // continue descending into container nodes
    }
    if (!node.textContent.includes('\n')) {
      return false // no need to descend into inline content
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
      return false
    }

    replacements.push({
      from: pos,
      to: pos + node.nodeSize,
      kind: 'soft-break-paragraphs',
      paragraphs: lines
    })

    return false // paragraph's inline children don't need further traversal
  })

  if (replacements.length === 0) {
    return
  }

  // Capture the transaction lazily — only after all replacements are collected.
  const tr = editor.view.state.tr

  // Apply replacements in reverse document order to preserve positions.
  replacements.sort((a, b) => b.from - a.from)
  for (const replacement of replacements) {
    if (replacement.kind === 'empty-list-item') {
      tr.replaceWith(replacement.from, replacement.to, replacement.node)
      continue
    }

    const newNodes = replacement.paragraphs.map((content) => paragraphType.create(null, content))
    tr.replaceWith(replacement.from, replacement.to, newNodes)
  }

  // Why: this normalization is a structural housekeeping step, not a user edit.
  // addToHistory: false prevents it from polluting the undo stack.
  editor.view.dispatch(tr.setMeta('addToHistory', false))
}
