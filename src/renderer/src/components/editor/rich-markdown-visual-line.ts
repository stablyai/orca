import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { writeRichMarkdownSliceToClipboard } from './rich-markdown-clipboard-write'
import { createRichMarkdownVisibleTextMap } from './rich-markdown-visible-text-map'

/** Find the visual cursor line for empty-selection cuts; null defers single-line/invalid layouts to block cutting. */
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

  const startCoords = view.coordsAtPos(paraStart)
  const endCoords = view.coordsAtPos(paraEnd)
  if (Math.abs(startCoords.top - endCoords.top) < lineHeight * 0.5) {
    return null
  }

  const domInfo = view.domAtPos(paraStart)
  const paraEl = domInfo.node instanceof HTMLElement ? domInfo.node : domInfo.node.parentElement
  if (!paraEl) {
    return null
  }
  const rect = paraEl.getBoundingClientRect()

  const midY = (cursorCoords.top + cursorCoords.bottom) / 2

  const startResult = view.posAtCoords({ left: rect.left + 1, top: midY })
  if (!startResult) {
    return null
  }
  const lineFrom = Math.max(startResult.pos, paraStart)

  const nextMidY = cursorCoords.bottom + lineHeight * 0.5
  const nextResult = view.posAtCoords({ left: rect.left + 1, top: nextMidY })

  const lineTo =
    nextResult && nextResult.pos > lineFrom && nextResult.pos <= paraEnd ? nextResult.pos : paraEnd

  // Cut whole paragraphs through the block path so their container node is removed too.
  if (lineFrom <= paraStart && lineTo >= paraEnd) {
    return null
  }

  return { from: lineFrom, to: lineTo }
}

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

  const lineText = createRichMarkdownVisibleTextMap(
    view.state.doc,
    lineRange.from,
    lineRange.to
  ).text
  const slice = view.state.doc.slice(lineRange.from, lineRange.to)
  if (!writeRichMarkdownSliceToClipboard(clipboardEvent.clipboardData, view, slice, lineText)) {
    return true
  }

  let tr = view.state.tr.delete(lineRange.from, lineRange.to)
  const clampedPos = Math.max(0, Math.min(lineRange.from, tr.doc.content.size))
  const resolvedPos = tr.doc.resolve(clampedPos)
  tr = tr.setSelection(TextSelection.near(resolvedPos))
  view.dispatch(tr)
  return true
}
