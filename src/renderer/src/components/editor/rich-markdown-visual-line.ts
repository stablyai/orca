import { DOMSerializer } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/**
 * Why: a paragraph that word-wraps across multiple screen lines should be cut
 * one visual line at a time when the user presses Cmd+X with an empty selection,
 * matching the expectation of per-line editing.  Uses ProseMirror's coordinate
 * helpers to detect visual line boundaries from the browser's text layout.
 *
 * Returns the document-position range of the visual line the cursor sits on,
 * or null when the paragraph fits on a single visual line (signaling the caller
 * to fall through to block-level cut).
 */
export function getVisualLineRange(
  view: EditorView,
  cursorPos: number,
  paraStart: number,
  paraEnd: number
): { from: number; to: number } | null {
  if (paraStart >= paraEnd) {
    return null
  }

  const cursorCoords = view.coordsAtPos(cursorPos)
  const lineHeight = cursorCoords.bottom - cursorCoords.top
  if (lineHeight <= 0) {
    return null
  }

  // Single visual line check: if paragraph start and end share a line, skip.
  const startCoords = view.coordsAtPos(paraStart)
  const endCoords = view.coordsAtPos(paraEnd)
  if (Math.abs(startCoords.top - endCoords.top) < lineHeight * 0.5) {
    return null
  }

  // Get the paragraph's DOM element for horizontal bounds.
  const domInfo = view.domAtPos(paraStart)
  const paraEl = domInfo.node instanceof HTMLElement ? domInfo.node : domInfo.node.parentElement
  if (!paraEl) {
    return null
  }
  const rect = paraEl.getBoundingClientRect()

  const midY = (cursorCoords.top + cursorCoords.bottom) / 2

  // Start of the current visual line.
  const startResult = view.posAtCoords({ left: rect.left + 1, top: midY })
  if (!startResult) {
    return null
  }
  const lineFrom = Math.max(startResult.pos, paraStart)

  // End of the current visual line = start of the next visual line.
  const nextMidY = cursorCoords.bottom + lineHeight * 0.5
  const nextResult = view.posAtCoords({ left: rect.left + 1, top: nextMidY })

  // Last visual line — cut to end of paragraph content.
  const lineTo =
    nextResult && nextResult.pos > lineFrom && nextResult.pos <= paraEnd ? nextResult.pos : paraEnd

  // If the range covers the entire paragraph, return null so the caller
  // falls through to block-level cut (which removes the paragraph node).
  if (lineFrom <= paraStart && lineTo >= paraEnd) {
    return null
  }

  return { from: lineFrom, to: lineTo }
}

/**
 * Cuts a single visual line from a word-wrapped paragraph, writing both
 * text/plain and text/html to the clipboard and deleting the range from
 * the ProseMirror document.  Returns true if the cut was handled.
 */
export function cutVisualLine(
  view: EditorView,
  event: Event,
  lineRange: { from: number; to: number }
): boolean {
  const clipboardEvent = event as ClipboardEvent
  if (!clipboardEvent.clipboardData) {
    return false
  }
  event.preventDefault()

  const lineText = view.state.doc.textBetween(lineRange.from, lineRange.to, '')
  const slice = view.state.doc.slice(lineRange.from, lineRange.to)
  const serializer = DOMSerializer.fromSchema(view.state.schema)
  const fragment = serializer.serializeFragment(slice.content)
  const div = document.createElement('div')
  div.appendChild(fragment)
  clipboardEvent.clipboardData.setData('text/html', div.innerHTML)
  clipboardEvent.clipboardData.setData('text/plain', lineText)

  let tr = view.state.tr.delete(lineRange.from, lineRange.to)
  const clampedPos = Math.max(0, Math.min(lineRange.from, tr.doc.content.size))
  const resolvedPos = tr.doc.resolve(clampedPos)
  tr = tr.setSelection(TextSelection.near(resolvedPos))
  view.dispatch(tr)
  return true
}
