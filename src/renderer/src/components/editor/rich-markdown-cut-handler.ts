import { DOMSerializer } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { cutVisualLine, getVisualLineRange } from './rich-markdown-visual-line'

function deleteBlockAndRestoreSelection(view: EditorView, from: number, to: number): void {
  let tr = view.state.tr.delete(from, to)
  // Why: after deleting the last block the old `from` offset may exceed
  // the new document length, so we clamp and use TextSelection.near() to
  // land on the closest valid cursor position.
  const clampedPos = Math.max(0, Math.min(from, tr.doc.content.size))
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(clampedPos)))
  view.dispatch(tr)
}

/**
 * Why: Electron's app menu `{ role: 'cut' }` binds Cmd/Ctrl+X at the
 * main-process level, so the keystroke never reaches handleKeyDown.
 * Instead, the menu dispatches a native cut command which fires this
 * DOM event. For empty selections we cut the current block (like VS
 * Code and Notion); for non-empty selections we defer to ProseMirror's
 * built-in clipboard serializer.
 */
export function handleRichMarkdownCut(view: EditorView, event: ClipboardEvent): boolean {
  const { selection } = view.state
  if (!selection.empty) {
    return false
  }

  const { $from } = selection

  // Why: a GapCursor before a top-level leaf node (e.g. horizontal rule
  // as the first child of the doc) resolves to depth 0. Attempting to cut
  // at depth 0 would call $from.before(0) on the doc node, which throws
  // RangeError("There is no position before the top-level node").  Bail
  // out and let ProseMirror's default handler deal with it.
  if ($from.depth < 1) {
    return false
  }

  // Walk up from the textblock to find the best node to cut. For list
  // items and task items, cut the whole item rather than just its inner
  // paragraph. Stop at table cells to avoid breaking table structure.
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
  const text = cutNode.textContent

  // Why: for paragraphs that word-wrap across multiple visual lines, cut
  // only the visual line the cursor is on rather than the entire paragraph.
  // This matches the user expectation of per-line cutting (like VS Code)
  // without destroying the rest of the paragraph's content.
  if (cutNode.type.name === 'paragraph' && text) {
    const paraStart = $from.start(cutDepth)
    const paraEnd = $from.end(cutDepth)
    const lineRange = getVisualLineRange(view, selection.from, paraStart, paraEnd)
    if (lineRange) {
      return cutVisualLine(view, event, lineRange)
    }
    // Falls through to block-level cut for single-line paragraphs.
  }

  if (!text) {
    // Still delete the empty block, matching VS Code behavior
    event.preventDefault()
    deleteBlockAndRestoreSelection(view, $from.before(cutDepth), $from.after(cutDepth))
    return true
  }

  // Why: if clipboardData is null (e.g. synthetic events), we must not
  // preventDefault and then delete -- that would lose content without
  // placing it on the clipboard. Fall back to browser default instead.
  if (!event.clipboardData) {
    return false
  }
  event.preventDefault()

  // Why: writing both text/html and text/plain preserves inline formatting
  // (bold, italic, links) on round-trip cut-then-paste, while still giving
  // a plain-text fallback for external targets.
  const serializer = DOMSerializer.fromSchema(view.state.schema)
  const fragment = serializer.serializeFragment(cutNode.content)
  const div = document.createElement('div')
  div.appendChild(fragment)
  event.clipboardData.setData('text/html', div.innerHTML)
  event.clipboardData.setData('text/plain', text)

  deleteBlockAndRestoreSelection(view, $from.before(cutDepth), $from.after(cutDepth))

  return true
}
