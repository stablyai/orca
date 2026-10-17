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
    return isHorizontalDominant(event) ? toWheelPixels(event.deltaX, event.deltaMode, pageWidth) : 0
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
    // At an edge, leave the gesture available to the outer diff list.
    if (nextLeft === currentLeft) {
      return
    }

    // Monaco rounds scroll positions, so consume only an actual move.
    editor.setScrollLeft(nextLeft)
    if (editor.getScrollLeft() === currentLeft) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
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
