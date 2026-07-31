import type { editor } from 'monaco-editor'

const WHEEL_LINE_PIXELS = 16

type HorizontalScrollEditor = Pick<
  editor.ICodeEditor,
  'getContainerDomNode' | 'getScrollLeft' | 'setScrollLeft'
>

type DiffEditorWithPanes = {
  getModifiedEditor: () => HorizontalScrollEditor
  getOriginalEditor: () => HorizontalScrollEditor
}

function getHorizontalWheelPixels(event: WheelEvent, pageWidth: number): number {
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return delta * WHEEL_LINE_PIXELS
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return delta * pageWidth
  }
  return delta
}

function installPaneShiftWheelScroll(editor: HorizontalScrollEditor): () => void {
  const container = editor.getContainerDomNode()
  const handleWheel = (event: WheelEvent): void => {
    if (event.defaultPrevented || !event.shiftKey) {
      return
    }

    const delta = getHorizontalWheelPixels(event, container.clientWidth)
    if (delta === 0) {
      return
    }

    // Why: combined diffs disable Monaco wheel handling so vertical input can reach the outer list.
    event.preventDefault()
    event.stopPropagation()
    editor.setScrollLeft(editor.getScrollLeft() + delta)
  }

  container.addEventListener('wheel', handleWheel, { capture: true, passive: false })
  return () => container.removeEventListener('wheel', handleWheel, true)
}

export function installDiffEditorShiftWheelScroll(editor: DiffEditorWithPanes): () => void {
  const cleanupOriginal = installPaneShiftWheelScroll(editor.getOriginalEditor())
  const cleanupModified = installPaneShiftWheelScroll(editor.getModifiedEditor())
  return () => {
    cleanupOriginal()
    cleanupModified()
  }
}
