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
  // Default position below the anchor, in offset-parent coordinates.
  belowTop: number
  lineHeight: number
  popoverHeight: number
  // Editor body height available before overflow clipping.
  viewportHeight: number
  margin?: number
}

// Flip above the anchor to avoid pane clipping; oversized popovers keep their top controls reachable.
export function resolveDiffCommentPopoverTop({
  belowTop,
  lineHeight,
  popoverHeight,
  viewportHeight,
  margin = POPOVER_VIEWPORT_MARGIN_PX
}: ResolveDiffCommentPopoverTopArgs): number {
  // Keep the default until geometry is measured.
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
  // Neither side fits; keep the label and textarea inside the viewport.
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
  // React overlays need the pane offset plus Monaco’s contentLeft to align with saved-note view zones.
  return Math.max(
    0,
    Math.round(editorRect.left - parentRect.left + editor.getLayoutInfo().contentLeft)
  )
}
