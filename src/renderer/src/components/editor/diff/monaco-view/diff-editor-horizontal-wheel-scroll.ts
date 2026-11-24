import type { editor } from 'monaco-editor'

const WHEEL_LINE_PIXELS = 16
const REMAINDER_IDLE_RESET_MS = 150

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

function getHorizontalWheelPixels(event: WheelEvent, pageWidth: number): number {
  const delta = event.shiftKey && !isHorizontalDominant(event) ? event.deltaY : event.deltaX
  return toWheelPixels(delta, event.deltaMode, pageWidth)
}

function getMaxScrollLeft(editor: HorizontalScrollEditor): number {
  return Math.max(0, editor.getScrollWidth() - editor.getLayoutInfo().contentWidth)
}

// Monaco keeps integer scroll positions and mirrors them across panes, so both panes share one remainder.
type SubPixelRemainder = { pixels: number; lastWheelAt: number }

function installPaneHorizontalWheelScroll(
  editor: HorizontalScrollEditor,
  remainder: SubPixelRemainder
): () => void {
  const container = editor.getContainerDomNode()
  const handleWheel = (event: WheelEvent): void => {
    // Wrapped panes have no horizontal overflow; yield their gesture to the outer list.
    const maxScrollLeft = getMaxScrollLeft(editor)
    if (event.defaultPrevented || maxScrollLeft === 0) {
      return
    }
    // Sideways drift in a vertical swipe or fling belongs to the outer list, not the pane.
    if (!event.shiftKey && !isHorizontalDominant(event)) {
      return
    }

    const wheelPixels = getHorizontalWheelPixels(event, container.clientWidth)
    if (wheelPixels === 0) {
      return
    }
    // A leftover partial pixel must not leak into a later, separate gesture.
    const idle = event.timeStamp - remainder.lastWheelAt > REMAINDER_IDLE_RESET_MS
    remainder.lastWheelAt = event.timeStamp
    if (idle || Math.sign(wheelPixels) !== Math.sign(remainder.pixels)) {
      remainder.pixels = 0
    }

    const scrollLeft = editor.getScrollLeft()
    // A pane at its edge cannot move; the outer list keeps the gesture.
    if (wheelPixels > 0 ? scrollLeft >= maxScrollLeft : scrollLeft <= 0) {
      remainder.pixels = 0
      return
    }

    // Combined diffs disable Monaco wheel handling so vertical input reaches the outer list.
    event.preventDefault()
    event.stopPropagation()

    const pendingPixels = remainder.pixels + wheelPixels
    const wholePixels = Math.trunc(pendingPixels)
    const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, scrollLeft + wholePixels))
    const reachedEdge = nextScrollLeft !== scrollLeft + wholePixels
    remainder.pixels = reachedEdge ? 0 : pendingPixels - wholePixels
    if (nextScrollLeft !== scrollLeft) {
      editor.setScrollLeft(nextScrollLeft)
    }
  }

  container.addEventListener('wheel', handleWheel, { capture: true, passive: false })
  return () => container.removeEventListener('wheel', handleWheel, true)
}

export function installDiffEditorHorizontalWheelScroll(editor: DiffEditorWithPanes): () => void {
  const remainder: SubPixelRemainder = { pixels: 0, lastWheelAt: 0 }
  const cleanupOriginal = installPaneHorizontalWheelScroll(editor.getOriginalEditor(), remainder)
  const cleanupModified = installPaneHorizontalWheelScroll(editor.getModifiedEditor(), remainder)
  return () => {
    cleanupOriginal()
    cleanupModified()
  }
}
