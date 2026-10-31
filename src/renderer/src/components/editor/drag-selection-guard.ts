import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import type { EditorView } from '@tiptap/pm/view'

type SelectionView = EditorView & {
  input: { mouseDown: { allowDefault: boolean } | null }
}

function selectionView(view: EditorView): SelectionView {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The pinned engine owns the live mouse tracker used by its transaction filter and terminal listeners.
  return view as SelectionView
}

/** Publish native input before an editor action consumes it or outgoing focus discards its endpoints. */
export function completeRichMarkdownSelection(editorView: EditorView, event?: Event): false {
  if (editorView.isDestroyed || !editorView.dom.isConnected || editorView.composing) {
    return false
  }
  editorView.completeNativeSelection(event?.type === 'blur')
  return false
}

// These editor handlers run through the engine's NodeView stopEvent gating, before model-consuming handlers.
export const richMarkdownSelectionCompletionEvents = {
  mousedown: completeRichMarkdownSelection,
  keydown: completeRichMarkdownSelection,
  beforeinput: completeRichMarkdownSelection,
  copy: completeRichMarkdownSelection,
  cut: completeRichMarkdownSelection,
  paste: completeRichMarkdownSelection,
  compositionstart: completeRichMarkdownSelection,
  dragstart: completeRichMarkdownSelection,
  blur: completeRichMarkdownSelection
}

/** Protect native drags while the editor remains the sole owner of the remembered selection. */
export const DragSelectionGuard = Extension.create({
  name: 'dragSelectionGuard',

  addProseMirrorPlugins() {
    let viewRef: SelectionView | null = null
    return [
      new Plugin({
        key: new PluginKey('dragSelectionGuard'),
        props: { nativeSelectionIntegration: true },
        filterTransaction(tr) {
          const mouseDown = viewRef?.input.mouseDown
          // Cell decorations force native selection rewrites during text drags (including Shift extension).
          return !(mouseDown?.allowDefault && tr.selection instanceof CellSelection)
        },
        view(editorView) {
          viewRef = selectionView(editorView)
          const doc = editorView.dom.ownerDocument
          const completeNativeGesture = (event: MouseEvent): void => {
            if (
              (event.type === 'mouseup' ? event.button === 0 : event.buttons === 0) &&
              viewRef?.input.mouseDown?.allowDefault &&
              editorView.hasFocus()
            ) {
              completeRichMarkdownSelection(editorView)
            }
          }
          doc.addEventListener('mouseup', completeNativeGesture, true)
          doc.addEventListener('mousemove', completeNativeGesture, true)
          return {
            destroy() {
              doc.removeEventListener('mouseup', completeNativeGesture, true)
              doc.removeEventListener('mousemove', completeNativeGesture, true)
              viewRef = null
            }
          }
        }
      })
    ]
  }
})
