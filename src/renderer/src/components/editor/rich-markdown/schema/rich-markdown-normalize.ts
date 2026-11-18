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
  // Use view.state for both traversal and transaction; editor.state can lag after setContent until React rerenders.
  const { doc, schema } = editor.view.state
  const paragraphType = schema.nodes.paragraph
  if (!paragraphType) {
    return
  }

  // Traverse nested containers too; top-level iteration misses blockquotes and table cells.
  const replacements: (
    | { from: number; to: number; kind: 'soft-break-paragraphs'; paragraphs: Fragment[] }
    | { from: number; to: number; kind: 'empty-list-item'; node: PmNode }
  )[] = []

  doc.descendants((node, pos) => {
    if (node.type.name === 'listItem' && node.childCount === 0) {
      // marked can emit paragraph-less empty list items before headings, leaving no editable caret target.
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
          // Scan soft-break boundaries directly to avoid split-array allocations in large pasted paragraphs.
          lines.push(Fragment.from(currentNodes))
          currentNodes = []
          segmentStart = index + 1
        }
      }
    })

    lines.push(Fragment.from(currentNodes))

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

  // Structural load normalization must not become a user undo step.
  editor.view.dispatch(tr.setMeta('addToHistory', false))
}
