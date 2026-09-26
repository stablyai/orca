import type { editor } from 'monaco-editor'

const WHEEL_LINE_PIXELS = 16

type HorizontalScrollEditor = Pick<
  editor.ICodeEditor,
  'getContainerDomNode' | 'getScrollLeft' | 'setScrollLeft' | 'getScrollWidth'
> & { getLayoutInfo: () => Pick<editor.EditorLayoutInfo, 'contentWidth'> }

type DiffEditorWithPanes = {
  getModifiedEditor: () => HorizontalScrollEditor
  getOriginalEditor: () => HorizontalScrollEditor
}

function toWheelPixels(delta: number, deltaMode: number, pageWidth: number): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return delta * WHEEL_LINE_PIXELS
  }
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return delta * pageWidth
  }
  return delta
}

function isHorizontalDominant(event: WheelEvent): boolean {
  return Math.abs(event.deltaX) > Math.abs(event.deltaY)
}

function horizontalWheelDelta(event: WheelEvent, pageWidth: number): number {
  if (!event.shiftKey) {
    return toWheelPixels(event.deltaX, event.deltaMode, pageWidth)
  }
  const raw = isHorizontalDominant(event) ? event.deltaX : event.deltaY
  return toWheelPixels(raw, event.deltaMode, pageWidth)
}

function maxScrollLeft(editor: HorizontalScrollEditor): number {
  return Math.max(0, editor.getScrollWidth() - editor.getLayoutInfo().contentWidth)
}

function installPaneHorizontalWheelScroll(editor: HorizontalScrollEditor): () => void {
  const container = editor.getContainerDomNode()
  const handleWheel = (event: WheelEvent): void => {
    const maxLeft = maxScrollLeft(editor)
    if (event.defaultPrevented || maxLeft === 0) {
      return
    }

    const currentLeft = editor.getScrollLeft()
    const nextLeft = Math.min(
      maxLeft,
      Math.max(0, currentLeft + horizontalWheelDelta(event, container.clientWidth))
    )
    // Why: at an edge the pane can't move; let the outer combined-diff scroller handle the event.
    if (nextLeft === currentLeft) {
      return
    }

    // Why: combined diffs set handleMouseWheel:false; don't consume vertical-dominant diagonals.
    if (event.shiftKey || isHorizontalDominant(event)) {
      event.preventDefault()
      event.stopPropagation()
    }
    editor.setScrollLeft(nextLeft)
  }

  container.addEventListener('wheel', handleWheel, { capture: true, passive: false })
  return () => container.removeEventListener('wheel', handleWheel, true)
}

export function installDiffEditorHorizontalWheelScroll(editor: DiffEditorWithPanes): () => void {
  const cleanupOriginal = installPaneHorizontalWheelScroll(editor.getOriginalEditor())
  const cleanupModified = installPaneHorizontalWheelScroll(editor.getModifiedEditor())
  return () => {
    cleanupOriginal()
    cleanupModified()
  }
}
