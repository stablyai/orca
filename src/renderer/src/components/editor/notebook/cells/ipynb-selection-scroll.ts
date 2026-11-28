import { MouseTargetType } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js'
import type { editor } from 'monaco-editor'
import {
  getDragAutoScrollStepPx,
  REFERENCE_FRAME_MS
} from '../../../diff-comments/diff-comment-drag-auto-scroll'

// Scroll each frame and update the highlight less often while the pointer stays still.
const SELECTION_INTERVAL_MS = 40

// Monaco recycles line nodes. Replay on the cell when the original text leaves the DOM.
function extendSelection(cell: HTMLElement, pointer: PointerEvent, clientY: number): boolean {
  const target =
    pointer.target instanceof Node && cell.contains(pointer.target) ? pointer.target : cell
  return !target.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      view: window,
      buttons: pointer.buttons,
      clientX: pointer.clientX,
      clientY,
      pointerId: pointer.pointerId,
      pointerType: pointer.pointerType,
      shiftKey: pointer.shiftKey,
      altKey: pointer.altKey,
      ctrlKey: pointer.ctrlKey,
      metaKey: pointer.metaKey
    })
  )
}

export function installIpynbSelectionScroll(
  editor: editor.IStandaloneCodeEditor,
  cell: HTMLElement
): void {
  const notebook = cell.closest<HTMLElement>('[data-ipynb-viewport]')
  const header = notebook?.querySelector<HTMLElement>('[data-ipynb-header]')
  if (!notebook || !header) {
    return
  }

  let stopDrag: (() => void) | undefined
  editor.onDidDispose(() => stopDrag?.())
  editor.onMouseDown(({ event, target }) => {
    stopDrag?.()
    if (
      !event.leftButton ||
      (target.type !== MouseTargetType.CONTENT_TEXT &&
        target.type !== MouseTargetType.CONTENT_EMPTY)
    ) {
      return
    }

    const controller = new AbortController()
    let pointer: PointerEvent | undefined
    let selecting = false
    let frame = 0
    let lastTime = 0
    let scrolledAtY: number | undefined
    let nextHitTest = 0
    const invalidateHit = (): void => {
      nextHitTest = 0
    }
    const layout = editor.onDidLayoutChange(invalidateHit)
    const changes = editor.onDidChangeCursorSelection(({ source, selection }) => {
      if (source === 'mouse' && !selection.isEmpty()) {
        selecting = true
      }
    })
    const stop = (): void => {
      controller.abort()
      cancelAnimationFrame(frame)
      changes.dispose()
      layout.dispose()
      stopDrag = undefined
    }
    stopDrag = stop

    const scroll = (time: number): void => {
      frame = 0
      const previousY = scrolledAtY
      scrolledAtY = undefined
      if (!pointer || !editor.hasTextFocus()) {
        return
      }
      const top = header.getBoundingClientRect().bottom
      const bottom = notebook.getBoundingClientRect().bottom
      const step = getDragAutoScrollStepPx({
        editorTop: top,
        editorBottom: bottom,
        clientY: pointer.clientY,
        frameDeltaMs: lastTime ? time - lastTime : REFERENCE_FRAME_MS
      })
      lastTime = 0
      if (!step) {
        return
      }
      const rect = cell.getBoundingClientRect()
      const remaining = step > 0 ? rect.bottom - bottom : top - rect.top
      // Monaco handles the drag itself once the pointer clears the physical cell.
      const outsideCell =
        remaining <= 0 && (pointer.clientY < rect.top || pointer.clientY > rect.bottom)
      const y = outsideCell
        ? pointer.clientY
        : Math.min(bottom - 1, Math.max(top + 1, pointer.clientY))
      if (!selecting && (y === pointer.clientY || !editor.getSelection()?.isEmpty())) {
        return
      }
      // An active Monaco drag consumes this move. Resizing or a non-modifier key can cancel it.
      const handledMove =
        previousY === undefined && y === pointer.clientY && pointer.defaultPrevented && selecting
      const refresh = time >= nextHitTest || outsideCell || (previousY !== y && !handledMove)
      if (refresh) {
        if (!extendSelection(cell, pointer, y) || !selecting || outsideCell) {
          return
        }
        nextHitTest = time + SELECTION_INTERVAL_MS
      }
      const before = notebook.scrollTop
      notebook.scrollTop += Math.sign(step) * Math.min(Math.abs(step), Math.max(remaining, 0))
      if (notebook.scrollTop === before) {
        const inner = editor.getScrollTop()
        editor.setScrollTop(inner + step)
        if (editor.getScrollTop() === inner) {
          if (!refresh) {
            extendSelection(cell, pointer, y)
          }
          return
        }
      }
      scrolledAtY = y
      lastTime = time
      frame = requestAnimationFrame(scroll)
    }

    const onPointer = (e: PointerEvent): void => {
      if (
        !e.isTrusted ||
        (e.pointerType !== 'mouse' && e.pointerType !== 'pen') ||
        (pointer && pointer.pointerId !== e.pointerId)
      ) {
        return
      }
      if (e.type !== 'pointermove' || e.buttons !== 1) {
        if (e.type === 'pointerup' && scrolledAtY !== undefined && pointer) {
          extendSelection(cell, pointer, scrolledAtY)
        }
        stop()
        return
      }
      scrolledAtY = undefined
      pointer = e
      nextHitTest = e.timeStamp + SELECTION_INTERVAL_MS
      if (!frame) {
        frame = requestAnimationFrame(scroll)
      }
    }
    const options = { capture: true, signal: controller.signal }
    for (const type of ['pointermove', 'pointerup', 'pointercancel'] as const) {
      window.addEventListener(type, onPointer, options)
    }
    window.addEventListener('keydown', invalidateHit, options)
    window.addEventListener('blur', stop, options)
  })
}
