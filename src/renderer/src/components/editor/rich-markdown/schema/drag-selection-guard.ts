import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'

/** Suppress ProseMirror selectionchange and table CellSelection updates during native drags; restore the native selection after state sync to preserve Chrome table highlighting. */
export const DragSelectionGuard = Extension.create({
  name: 'dragSelectionGuard',

  addProseMirrorPlugins() {
    // Share the active view between view and filterTransaction hooks.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let viewRef: any = null
    let suppressedDuringDrag = false

    return [
      new Plugin({
        key: new PluginKey('dragSelectionGuard'),

        // Table CellSelection decorations force selectionToDOM past Chrome’s drag guards; block those transactions during text drags.
        filterTransaction(tr) {
          if (!viewRef) {
            return true
          }
          const mouseDown = viewRef.input.mouseDown
          if (mouseDown && mouseDown.allowDefault && tr.selection instanceof CellSelection) {
            return false
          }
          return true
        },

        view(editorView) {
          // Access ProseMirror’s private observer/input state because no public API exposes these hooks.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          viewRef = editorView as any
          const observer = viewRef.domObserver
          const doc = editorView.dom.ownerDocument

          const originalOnSelectionChange: () => void = observer.onSelectionChange
          let mouseUpFrameId: number | null = null

          doc.removeEventListener('selectionchange', originalOnSelectionChange)

          const patchedOnSelectionChange = (): void => {
            const mouseDown = viewRef.input.mouseDown
            // allowDefault becomes true after four pixels; suppress actual drags while preserving click-to-place-cursor.
            if (mouseDown && mouseDown.allowDefault) {
              // Refresh stored DOM selection so direct transactions pass updateStateInner’s selection guard.
              observer.setCurSelection()
              suppressedDuringDrag = true
              return
            }
            originalOnSelectionChange()
          }

          // Replace the observer property too so internal disconnect/reconnect cycles keep using the patched listener.
          observer.onSelectionChange = patchedOnSelectionChange
          doc.addEventListener('selectionchange', patchedOnSelectionChange)

          const handleMouseUp = (): void => {
            if (!suppressedDuringDrag) {
              return
            }
            suppressedDuringDrag = false
            if (mouseUpFrameId !== null) {
              cancelAnimationFrame(mouseUpFrameId)
            }
            mouseUpFrameId = requestAnimationFrame(() => {
              mouseUpFrameId = null
              // Destruction before this frame clears viewRef and may disconnect the DOM; stop before reading selection.
              if (!viewRef || !editorView.dom.isConnected) {
                return
              }
              // A new drag can start before this frame; leave its native selection untouched.
              const mouseDown = viewRef?.input?.mouseDown
              if (mouseDown && mouseDown.allowDefault) {
                return
              }
              // Capture before ProseMirror rewrites selection: Chrome’s native table highlight is lost through collapse/extend.
              const domSel = viewRef.domSelectionRange()
              const savedAnchor: Node | null = domSel.anchorNode
              const savedAnchorOff: number = domSel.anchorOffset
              const savedFocus: Node | null = domSel.focusNode
              const savedFocusOff: number = domSel.focusOffset

              // Reset stored selection to a sentinel so flush reads the final native drag selection into state.
              observer.currentSelection.set({
                anchorNode: null,
                anchorOffset: 0,
                focusNode: null,
                focusOffset: 0
              })
              observer.flush()

              // Pause observation while restoring native selection so Chrome keeps table highlighting without another selectionToDOM cycle.
              if (
                savedAnchor &&
                savedFocus &&
                (savedAnchor as Element).isConnected &&
                (savedFocus as Element).isConnected
              ) {
                const sel = doc.getSelection()
                if (sel) {
                  observer.stop()
                  sel.setBaseAndExtent(savedAnchor, savedAnchorOff, savedFocus, savedFocusOff)
                  observer.setCurSelection()
                  observer.start()
                }
              }
            })
          }

          doc.addEventListener('mouseup', handleMouseUp)

          return {
            destroy() {
              if (mouseUpFrameId !== null) {
                cancelAnimationFrame(mouseUpFrameId)
                mouseUpFrameId = null
              }
              doc.removeEventListener('mouseup', handleMouseUp)
              doc.removeEventListener('selectionchange', patchedOnSelectionChange)
              observer.onSelectionChange = originalOnSelectionChange
              doc.addEventListener('selectionchange', originalOnSelectionChange)
              // Plugin views are destroyed after the observer disconnects; remove its restored callback on the next microtask.
              queueMicrotask(() => {
                if (editorView.isDestroyed) {
                  doc.removeEventListener('selectionchange', originalOnSelectionChange)
                }
              })
              viewRef = null
            }
          }
        }
      })
    ]
  }
})
