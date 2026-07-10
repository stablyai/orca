import type { Editor } from '@tiptap/core'
import { Fragment, type Node as PmNode } from '@tiptap/pm/model'

type NormalizeOptions = {
  splitSoftBreakParagraphs: boolean
}

export function normalizeEmptyListItems(editor: Editor): void {
  normalizeRichMarkdownDocument(editor, { splitSoftBreakParagraphs: false })
}

export function normalizeSoftBreaks(editor: Editor): void {
  normalizeRichMarkdownDocument(editor, { splitSoftBreakParagraphs: true })
}

function normalizeRichMarkdownDocument(editor: Editor, options: NormalizeOptions): void {
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
    if (!options.splitSoftBreakParagraphs) {
      // Document-editor prose reflows soft breaks through CSS, preserving clean diffs.
      return false
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

      const text = child.text!
      let segmentStart = 0
      for (let index = 0; index <= text.length; index += 1) {
        if (index < text.length && text.charCodeAt(index) !== 10) {
          continue
        }
        if (index > segmentStart) {
          currentNodes.push(schema.text(text.slice(segmentStart, index), child.marks))
        }
        if (index < text.length) {
          // Why: pasted markdown paragraphs can contain thousands of soft line
          // breaks; scan boundaries directly instead of allocating a split array.
          lines.push(Fragment.from(currentNodes))
          currentNodes = []
          segmentStart = index + 1
        }
      }
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
