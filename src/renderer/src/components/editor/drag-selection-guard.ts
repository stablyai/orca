import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'

/**
 * Workaround for ProseMirror/Chrome drag-selection breakage.
 *
 * Problem 1 — selectionToDOM overwrites native drag selection:
 * During a mouse drag, Chrome fires `selectionchange` events on every mouse
 * move. ProseMirror's DOMObserver picks these up, dispatches selection-only
 * transactions, and calls `selectionToDOM()` to push the ProseMirror selection
 * back to the DOM. A Chrome-specific guard in `selectionToDOM` should detect
 * the drag and bail out, but it relies on `isEquivalentPosition()` — a DOM
 * scan that stops at `contenteditable="false"` boundaries and fails when
 * ProseMirror ↔ DOM position mapping is lossy (tables, raw-HTML atom nodes).
 *
 * Problem 2 — prosemirror-tables forces selectionToDOM:
 * The prosemirror-tables plugin has its own mousedown handler that registers a
 * mousemove listener. When the user drags from one cell to another (or outside
 * the table), it dispatches `CellSelection` transactions that cause decoration
 * changes, which force `selectionToDOM(view, true)` — bypassing both guards.
 *
 * Problem 3 — post-mouseup selection round-trip loses table highlight:
 * Chrome renders drag-created selections differently from programmatically-set
 * selections. ProseMirror's `selectionToDOM` uses `collapse()`+`extend()` to
 * set the DOM selection, which causes Chrome to lose the native table-cell
 * highlighting that the drag selection had.
 *
 * Fix — three layers:
 * 1. Suppress `DOMObserver.onSelectionChange` during drag so the
 *    selectionchange → flush → dispatch → selectionToDOM path never fires.
 *    Call `setCurSelection()` to keep the stored DOM selection fresh so the
 *    `updateStateInner` guard passes for any direct dispatches.
 * 2. Block `CellSelection` transactions via `filterTransaction` during drag,
 *    preventing the prosemirror-tables decoration path.
 * 3. On mouseup, save the native selection, flush the DOMObserver to sync
 *    ProseMirror state, then restore the native selection so Chrome preserves
 *    the table highlight.
 *
 * Safe to revisit when ProseMirror's Chrome drag guard improves upstream.
 */
export const DragSelectionGuard = Extension.create({
  name: 'dragSelectionGuard',

  addProseMirrorPlugins() {
    // Why: shared across the plugin's view() and filterTransaction() hooks.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let viewRef: any = null
    let suppressedDuringDrag = false

    return [
      new Plugin({
        key: new PluginKey('dragSelectionGuard'),

        // Why: the prosemirror-tables plugin dispatches CellSelection
        // transactions from its own mousemove handler during drag. These
        // cause decoration changes → forceSelUpdate → selectionToDOM(force)
        // which bypasses both Chrome guards. Blocking CellSelection
        // creation during a text drag prevents this forced overwrite.
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
          // Why: domObserver and input are ProseMirror-internal properties
          // with no public API. The cast is required to access them.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          viewRef = editorView as any
          const observer = viewRef.domObserver
          const doc = editorView.dom.ownerDocument

          const originalOnSelectionChange: () => void = observer.onSelectionChange

          // Remove the listener registered by ProseMirror's DOMObserver constructor
          doc.removeEventListener('selectionchange', originalOnSelectionChange)

          const patchedOnSelectionChange = (): void => {
            const mouseDown = viewRef.input.mouseDown
            // Why: allowDefault is false on initial click, then becomes true
            // once the mouse moves ≥ 4 px — i.e. it's a genuine drag, not a
            // click. We only suppress during actual drags so normal
            // click-to-place-cursor events are processed as usual.
            if (mouseDown && mouseDown.allowDefault) {
              // Why: keep the stored DOM selection reference in sync so the
              // `updateStateInner` guard (`currentSelection.eq(domSelectionRange())`)
              // passes for any direct dispatches that occur during drag.
              observer.setCurSelection()
              suppressedDuringDrag = true
              return
            }
            originalOnSelectionChange()
          }

          // Why: replacing the property ensures that ProseMirror's own
          // connectSelection / disconnectSelection (which reference
          // `this.onSelectionChange`) use our patched version, so the patch
          // survives internal stop() / start() cycles.
          observer.onSelectionChange = patchedOnSelectionChange
          doc.addEventListener('selectionchange', patchedOnSelectionChange)

          const handleMouseUp = (): void => {
            if (!suppressedDuringDrag) {
              return
            }
            suppressedDuringDrag = false
            requestAnimationFrame(() => {
              // Why: if the plugin was destroyed between mouseup and this
              // rAF callback, viewRef is null — bail out to avoid a
              // TypeError on viewRef.domSelectionRange().
              if (!viewRef || !editorView.dom.isConnected) {
                return
              }
              // Why: if a new drag started between mouseup and this rAF
              // callback (extremely unlikely but possible within a single
              // frame), bail out to avoid disrupting the new drag's
              // native selection.
              const mouseDown = viewRef?.input?.mouseDown
              if (mouseDown && mouseDown.allowDefault) {
                return
              }
              // Why: capture the native drag selection BEFORE ProseMirror
              // touches it. Chrome renders drag-created selections differently
              // from programmatically-set ones (table cells stay highlighted
              // with a drag selection but lose highlighting when set via
              // collapse + extend).
              const domSel = viewRef.domSelectionRange()
              const savedAnchor: Node | null = domSel.anchorNode
              const savedAnchorOff: number = domSel.anchorOffset
              const savedFocus: Node | null = domSel.focusNode
              const savedFocusOff: number = domSel.focusOffset

              // Why: force ProseMirror to read the final native selection and
              // update its state. Resetting the stored selection to a sentinel
              // makes flush() treat the current DOM selection as new.
              observer.currentSelection.set({
                anchorNode: null,
                anchorOffset: 0,
                focusNode: null,
                focusOffset: 0
              })
              observer.flush()

              // Why: restore the native drag selection so Chrome preserves
              // table-cell highlighting. We pause the DOMObserver around the
              // restore to prevent the selection write from triggering another
              // flush → dispatch → selectionToDOM cycle.
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
              doc.removeEventListener('mouseup', handleMouseUp)
              doc.removeEventListener('selectionchange', patchedOnSelectionChange)
              observer.onSelectionChange = originalOnSelectionChange
              doc.addEventListener('selectionchange', originalOnSelectionChange)
              viewRef = null
            }
          }
        }
      })
    ]
  }
})
