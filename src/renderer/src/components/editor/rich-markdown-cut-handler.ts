import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { writeRichMarkdownSliceToClipboard } from './rich-markdown-clipboard-write'
import { cutVisualLine, getVisualLineRange } from './rich-markdown-visual-line'
import { createRichMarkdownVisibleTextMap } from './rich-markdown-visible-text-map'
import { inspectRichMarkdownSourceOwningSlice } from './rich-markdown-source-owning-slice'
import { showRichMarkdownSourceOwningCutLimitError } from './rich-markdown-source-owning-cut-feedback'

function deleteBlockAndRestoreSelection(view: EditorView, from: number, to: number): void {
  let tr = view.state.tr.delete(from, to)
  // Deleting the last block can leave from beyond the new document; clamp to a valid nearby cursor.
  const clampedPos = Math.max(0, Math.min(from, tr.doc.content.size))
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(clampedPos)))
  view.dispatch(tr)
}

/** The native menu dispatches cut before key handlers; cut the current block for empty selections and defer selected slices to ProseMirror. */
export function handleRichMarkdownCut(view: EditorView, event: ClipboardEvent): boolean {
  const { selection } = view.state
  if (!selection.empty) {
    const status = inspectRichMarkdownSourceOwningSlice(selection.content())
    if (status.containsSourceOwningNode && !status.canPreserve) {
      event.preventDefault()
      showRichMarkdownSourceOwningCutLimitError()
      return true
    }
    return false
  }

  const { $from } = selection

  // GapCursor can resolve at depth zero, where before(0) throws; defer to ProseMirror.
  if ($from.depth < 1) {
    return false
  }

  // Cut whole list/task items while stopping at table cells to preserve table structure.
  let cutDepth = $from.depth
  for (let d = $from.depth - 1; d >= 1; d--) {
    const name = $from.node(d).type.name
    if (name === 'listItem' || name === 'taskItem') {
      cutDepth = d
      break
    }
    if (name === 'tableCell' || name === 'tableHeader') {
      break
    }
  }

  const cutNode = $from.node(cutDepth)
  const contentFrom = $from.start(cutDepth)
  const contentTo = $from.end(cutDepth)
  const text = createRichMarkdownVisibleTextMap(view.state.doc, contentFrom, contentTo).text

  // For wrapped paragraphs, cut only the visual cursor line so the rest of the paragraph survives.
  if (cutNode.type.name === 'paragraph' && text) {
    const paraStart = $from.start(cutDepth)
    const paraEnd = $from.end(cutDepth)
    const lineRange = getVisualLineRange(view, selection.from, paraStart, paraEnd)
    if (lineRange) {
      return cutVisualLine(view, event, lineRange)
    }
    // Falls through to block-level cut for single-line paragraphs.
  }

  // Images and source atoms can have no visible text.
  let hasContentAtom = false
  if (!text) {
    cutNode.descendants((node) => {
      if (node.isAtom && !node.isText && node.type.name !== 'hardBreak') {
        hasContentAtom = true
      }
      return !hasContentAtom
    })
  }

  if (!text && !hasContentAtom) {
    event.preventDefault()
    deleteBlockAndRestoreSelection(view, $from.before(cutDepth), $from.after(cutDepth))
    return true
  }

  // Without clipboardData, leave deletion to the browser or content could be lost without reaching the clipboard.
  if (!event.clipboardData) {
    return false
  }
  event.preventDefault()

  const slice = view.state.doc.slice($from.before(cutDepth), $from.after(cutDepth))
  if (!writeRichMarkdownSliceToClipboard(event.clipboardData, view, slice, text)) {
    return true
  }

  deleteBlockAndRestoreSelection(view, $from.before(cutDepth), $from.after(cutDepth))

  return true
}
