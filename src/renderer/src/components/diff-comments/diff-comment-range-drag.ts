import * as monaco from 'monaco-editor'
import type { editor as monacoEditor } from 'monaco-editor'
import { getDragAutoScrollStepPx, REFERENCE_FRAME_MS } from './diff-comment-drag-auto-scroll'
import {
  areLineRangesEqual,
  clampFocusLineToCommentable,
  orderLineRange,
  type DiffCommentLineRange
} from './diff-comment-line-range'

// Capture pointerdown before Monaco’s bubble handler on the same view node so gutter selection cannot compete with the drag.

export type DiffCommentRangeDragEditor = Pick<
  monacoEditor.ICodeEditor,
  | 'createDecorationsCollection'
  | 'getLayoutInfo'
  | 'getModel'
  | 'getScrollHeight'
  | 'getScrollTop'
  | 'getTargetAtClientPoint'
  | 'onDidDispose'
  | 'setScrollTop'
>

type RangeDragArgs = {
  editor: DiffCommentRangeDragEditor
  editorDomNode: HTMLElement
  commentableLineSet: ReadonlySet<number> | null
  /** Resolves the line a press lands on, or null when the press isn't ours to take. */
  resolvePressLine: (event: PointerEvent) => number | null
  /** Fired on press, on every line the focus moves to, and on release. */
  onDragChange?: (state: { dragging: boolean; focusLine: number | null }) => void
  onCommit: (range: DiffCommentLineRange) => void
}

export type DiffCommentRangeDragHandle = {
  dispose: () => void
  /** The range of the open composer; keeps the band lit while the note is being written. */
  setPendingRange: (range: DiffCommentLineRange | null) => void
  /** True while a press owns the band, so keyboard paths can stand aside instead of racing it. */
  isDragging: () => boolean
}

// Claim line numbers only: decoration presses toggle folds. The external add button resolves separately.
const GUTTER_PRESS_TARGET_TYPES: ReadonlySet<monacoEditor.MouseTargetType> = new Set([
  monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
])

// Far enough into the text column to clear the gutter, close enough to stay on every line.
const CONTENT_PROBE_INSET_PX = 4

export function getGutterPressLine(
  editor: Pick<DiffCommentRangeDragEditor, 'getTargetAtClientPoint'>,
  event: PointerEvent
): number | null {
  const target = editor.getTargetAtClientPoint(event.clientX, event.clientY)
  if (!target || !GUTTER_PRESS_TARGET_TYPES.has(target.type)) {
    return null
  }
  return target.position?.lineNumber ?? null
}

export function installDiffCommentRangeDrag({
  editor,
  editorDomNode,
  commentableLineSet,
  resolvePressLine,
  onDragChange,
  onCommit
}: RangeDragArgs): DiffCommentRangeDragHandle {
  const decorations = editor.createDecorationsCollection()
  let pendingRange: DiffCommentLineRange | null = null
  let paintedRange: DiffCommentLineRange | null = null
  let disposed = false

  let drag: {
    pointerId: number
    anchorLine: number
    focusLine: number
    clientY: number
    frame: number | null
    lastFrameMs: number | null
  } | null = null

  const paint = (range: DiffCommentLineRange | null): void => {
    if (areLineRangesEqual(range, paintedRange)) {
      return
    }
    paintedRange = range
    if (!range) {
      decorations.clear()
      return
    }
    decorations.set([
      {
        range: new monaco.Range(range.startLine, 1, range.endLine, 1),
        options: {
          isWholeLine: true,
          className: 'orca-diff-comment-range-highlight',
          marginClassName: 'orca-diff-comment-range-margin'
        }
      }
    ])
  }

  // Disposal always lands on an empty band, so a teardown mid-composer can't leave one behind.
  const repaint = (): void => {
    if (disposed) {
      paint(null)
      return
    }
    paint(drag ? orderLineRange(drag.anchorLine, drag.focusLine) : pendingRange)
  }

  const cancelFrame = (): void => {
    if (drag?.frame != null) {
      cancelAnimationFrame(drag.frame)
      drag.frame = null
    }
  }

  // Probe inside the text column: Monaco cannot resolve positions over the external add button.
  const getLineAtViewportY = (editorLeft: number, clientY: number): number | null => {
    const model = editor.getModel()
    if (!model) {
      return null
    }
    const probeX = editorLeft + editor.getLayoutInfo().contentLeft + CONTENT_PROBE_INSET_PX
    const line = editor.getTargetAtClientPoint(probeX, clientY)?.position?.lineNumber
    return line == null ? null : Math.max(1, Math.min(model.getLineCount(), line))
  }

  const autoScroll = (rect: DOMRect, clientY: number, frameDeltaMs: number): boolean => {
    const step = getDragAutoScrollStepPx({
      editorTop: rect.top,
      editorBottom: rect.bottom,
      clientY,
      frameDeltaMs
    })
    if (step === 0) {
      return false
    }
    const maxScrollTop = Math.max(0, editor.getScrollHeight() - editor.getLayoutInfo().height)
    const scrollTop = editor.getScrollTop()
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, scrollTop + step))
    if (nextScrollTop === scrollTop) {
      return false
    }
    editor.setScrollTop(nextScrollTop)
    return true
  }

  // Clamp offscreen coordinates to the viewport edge so dragging beyond it keeps extending the range.
  const resolveFocusLine = (active: NonNullable<typeof drag>, rect: DOMRect): void => {
    const clampedY = Math.max(rect.top + 1, Math.min(rect.bottom - 1, active.clientY))
    const probed = getLineAtViewportY(rect.left, clampedY)
    if (probed !== null) {
      const nextFocus = clampFocusLineToCommentable(active.anchorLine, probed, commentableLineSet)
      if (nextFocus !== active.focusLine) {
        active.focusLine = nextFocus
        onDragChange?.({ dragging: true, focusLine: nextFocus })
      }
    }
  }

  // Coalesce pointer bursts into one hit-test, scroll step and decoration write per frame.
  const runFrame = (timestampMs: number): void => {
    if (!drag || disposed) {
      return
    }
    drag.frame = null
    const frameDeltaMs =
      drag.lastFrameMs === null ? REFERENCE_FRAME_MS : timestampMs - drag.lastFrameMs
    drag.lastFrameMs = timestampMs
    const rect = editorDomNode.getBoundingClientRect()
    const scrolling = autoScroll(rect, drag.clientY, frameDeltaMs)
    resolveFocusLine(drag, rect)
    repaint()
    // Continue frames only while edge scrolling; a stationary interior pointer needs no work.
    if (scrolling) {
      scheduleFrame()
    }
  }

  const scheduleFrame = (): void => {
    if (!drag || drag.frame != null || disposed) {
      return
    }
    drag.frame = requestAnimationFrame(runFrame)
  }

  const endDrag = (): void => {
    cancelFrame()
    const finished = drag
    drag = null
    if (finished) {
      detachDragListeners()
      releasePointerCapture(editorDomNode, finished.pointerId)
      onDragChange?.({ dragging: false, focusLine: null })
    }
    repaint()
  }

  const handlePointerUp = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return
    }
    // Resolve pointerup before committing: it may precede the frame or contain unseen coordinates. Do not scroll after release.
    drag.clientY = event.clientY
    cancelFrame()
    resolveFocusLine(drag, editorDomNode.getBoundingClientRect())
    const range = orderLineRange(drag.anchorLine, drag.focusLine)
    endDrag()
    onCommit(range)
  }

  const handlePointerCancel = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return
    }
    endDrag()
  }

  const handlePointerMove = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return
    }
    drag.clientY = event.clientY
    scheduleFrame()
  }

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (drag && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      endDrag()
    }
  }

  const handlePointerDown = (event: PointerEvent): void => {
    // A press while the composer is open belongs to the composer's outside-click dismissal.
    if (drag || pendingRange || disposed) {
      return
    }
    // Touch keeps scrolling the pane; ctrl+click on macOS is the context menu.
    if (event.button !== 0 || event.pointerType === 'touch' || event.ctrlKey) {
      return
    }
    const anchorLine = resolvePressLine(event)
    if (anchorLine === null) {
      return
    }
    if (commentableLineSet !== null && !commentableLineSet.has(anchorLine)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    capturePointer(editorDomNode, event.pointerId)
    attachDragListeners()
    drag = {
      pointerId: event.pointerId,
      anchorLine,
      focusLine: anchorLine,
      clientY: event.clientY,
      frame: null,
      lastFrameMs: null
    }
    onDragChange?.({ dragging: true, focusLine: anchorLine })
    repaint()
  }

  // Chromium emits compatibility mousedown after cancelled pointerdown; swallow it to prevent Monaco selection underneath.
  const handleMouseDown = (event: MouseEvent): void => {
    if (drag) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  // Document listeners finish off-pane releases even without capture; bind only during drags because combined diffs mount one controller per section.
  function attachDragListeners(): void {
    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', handlePointerCancel)
    document.addEventListener('lostpointercapture', handlePointerCancel)
    document.addEventListener('keydown', handleKeyDown, true)
  }

  function detachDragListeners(): void {
    document.removeEventListener('pointermove', handlePointerMove)
    document.removeEventListener('pointerup', handlePointerUp)
    document.removeEventListener('pointercancel', handlePointerCancel)
    document.removeEventListener('lostpointercapture', handlePointerCancel)
    document.removeEventListener('keydown', handleKeyDown, true)
  }

  editorDomNode.addEventListener('pointerdown', handlePointerDown, true)
  editorDomNode.addEventListener('mousedown', handleMouseDown, true)
  const editorDisposeListener = editor.onDidDispose(() => {
    disposed = true
    endDrag()
  })

  return {
    dispose: () => {
      disposed = true
      endDrag()
      editorDomNode.removeEventListener('pointerdown', handlePointerDown, true)
      editorDomNode.removeEventListener('mousedown', handleMouseDown, true)
      editorDisposeListener.dispose()
      decorations.clear()
      paintedRange = null
    },
    setPendingRange: (range) => {
      if (areLineRangesEqual(range, pendingRange)) {
        return
      }
      pendingRange = range
      repaint()
    },
    isDragging: () => drag !== null
  }
}

// Capture preserves releases outside the window; test DOMs may lack it.
function capturePointer(node: HTMLElement, pointerId: number): void {
  if (typeof node.setPointerCapture !== 'function') {
    return
  }
  try {
    node.setPointerCapture(pointerId)
  } catch {
    // The pointer is already gone; the document listeners still finish the drag.
  }
}

function releasePointerCapture(node: HTMLElement, pointerId: number): void {
  if (typeof node.releasePointerCapture !== 'function') {
    return
  }
  try {
    node.releasePointerCapture(pointerId)
  } catch {
    // Capture was never taken or already lost.
  }
}
