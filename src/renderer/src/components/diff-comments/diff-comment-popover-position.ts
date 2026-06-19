import type { editor as monacoEditor } from 'monaco-editor'

type DiffCommentPopoverEditor = Pick<
  monacoEditor.ICodeEditor,
  'getModel' | 'getScrollTop' | 'getTopForLineNumber'
>

type DiffCommentPopoverLeftEditor = Pick<monacoEditor.ICodeEditor, 'getDomNode' | 'getLayoutInfo'>

const FALLBACK_LINE_HEIGHT_PX = 19

export function getDiffCommentPopoverTop(
  editor: DiffCommentPopoverEditor,
  lineNumber: number,
  lineHeight: unknown
): number | null {
  const model = editor.getModel()
  if (!model) {
    return null
  }
  if (lineNumber < 1 || lineNumber > model.getLineCount()) {
    return null
  }
  const resolvedLineHeight =
    typeof lineHeight === 'number' && lineHeight > 0 ? lineHeight : FALLBACK_LINE_HEIGHT_PX
  return editor.getTopForLineNumber(lineNumber) - editor.getScrollTop() + resolvedLineHeight
}

const POPOVER_VIEWPORT_MARGIN_PX = 8

export type ResolveDiffCommentPopoverTopArgs = {
  // Top of the popover when it opens just below the anchor line — the value
  // getDiffCommentPopoverTop returns — in offset-parent coordinates.
  belowTop: number
  lineHeight: number
  popoverHeight: number
  // Visible height of the popover's offset parent (the editor body), which is
  // the region an overflow ancestor clips the popover against.
  viewportHeight: number
  margin?: number
}

// Why: the popover anchors below the selected line by default, but near the
// bottom of the viewport that downward box is clipped by the editor pane's
// overflow container. Flip it above the line when it doesn't fit below; if it
// fits neither way (popover taller than the viewport) clamp it inside the
// visible area so the footer actions stay reachable.
export function resolveDiffCommentPopoverTop({
  belowTop,
  lineHeight,
  popoverHeight,
  viewportHeight,
  margin = POPOVER_VIEWPORT_MARGIN_PX
}: ResolveDiffCommentPopoverTopArgs): number {
  // Geometry not measured yet (first paint): keep the default below position.
  if (popoverHeight <= 0 || viewportHeight <= 0) {
    return belowTop
  }
  if (belowTop + popoverHeight + margin <= viewportHeight) {
    return belowTop
  }
  const aboveTop = belowTop - lineHeight - popoverHeight
  if (aboveTop >= margin) {
    return aboveTop
  }
  // Neither side fits cleanly: clamp within the viewport, keeping the top edge
  // visible so the label and textarea stay reachable.
  const maxTop = viewportHeight - popoverHeight - margin
  return Math.max(margin, Math.min(belowTop, maxTop))
}

export function getDiffCommentPopoverLeft(
  editor: DiffCommentPopoverLeftEditor,
  offsetParent: HTMLElement | null
): number | null {
  const editorDomNode = editor.getDomNode()
  if (!editorDomNode || !offsetParent) {
    return null
  }
  const editorRect = editorDomNode.getBoundingClientRect()
  const parentRect = offsetParent.getBoundingClientRect()
  // Why: saved notes live in Monaco view zones, which start at the editor
  // content column. The popover is a React sibling overlay, so it must add the
  // editor pane's offset before applying Monaco's contentLeft.
  return Math.max(
    0,
    Math.round(editorRect.left - parentRect.left + editor.getLayoutInfo().contentLeft)
  )
}
