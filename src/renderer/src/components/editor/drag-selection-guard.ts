import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import type { EditorView } from '@tiptap/pm/view'

type NativeRange = {
  anchorNode: Node | null
  anchorOffset: number
  focusNode: Node | null
  focusOffset: number
}

type SelectionView = EditorView & {
  input: { mouseDown: { allowDefault: boolean } | null }
  domSelectionRange(): NativeRange
  domObserver: {
    onSelectionChange(): void
    setCurSelection(): void
    forceFlush(): void
    flush(): void
    pendingRecords(): MutationRecord[]
    currentSelection: { clear(): void }
    stop(): void
    start(): void
    ignoreSelectionChange(selection: NativeRange): boolean
    handleDOMChange(from: number, to: number, typeOver: boolean, added: Node[]): void
  }
}

function selectionView(view: EditorView): SelectionView {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The pinned engine's existing observer bridge owns these internal input/selection hooks.
  return view as SelectionView
}

/** Publish native input before an editor action consumes it or outgoing focus discards its endpoints. */
export function completeRichMarkdownSelection(editorView: EditorView): false {
  if (editorView.isDestroyed || !editorView.dom.isConnected || editorView.composing) {
    return false
  }
  const view = selectionView(editorView)
  while (!view.isDestroyed && view.dom.isConnected && !view.composing) {
    const observer = view.domObserver
    const initialSelection = view.state.selection
    const ownerBeforeFlush = view.root.activeElement
    observer.forceFlush()
    if (view.isDestroyed || !view.dom.isConnected || view.composing) {
      return false
    }
    // forceFlush only services a scheduled flush; actual mutation records can still be undelivered.
    if (observer.pendingRecords().length) {
      observer.flush()
      if (view.isDestroyed || !view.dom.isConnected || view.composing) {
        return false
      }
    }

    // A synchronous focus handoff completes at nested blur; its later model navigation owns the target.
    if (view.root.activeElement !== ownerBeforeFlush) {
      return false
    }
    const state = view.state
    const owner = view.root.activeElement
    const native = view.domSelectionRange()
    const range: NativeRange = {
      anchorNode: native.anchorNode,
      anchorOffset: native.anchorOffset,
      focusNode: native.focusNode,
      focusOffset: native.focusOffset
    }
    const { anchorNode, anchorOffset, focusNode, focusOffset } = range
    if (
      !anchorNode ||
      !focusNode ||
      !view.dom.contains(anchorNode) ||
      !view.dom.contains(focusNode)
    ) {
      return false
    }
    const ignored = observer.ignoreSelectionChange(range)
    if (view.isDestroyed || !view.dom.isConnected || view.composing) {
      return false
    }
    if (view.root.activeElement !== owner) {
      return false
    }
    // A NodeView callback may replace the document or reconfigure the live view before mapping.
    if (view.state.doc !== state.doc || view.state.plugins !== state.plugins) {
      continue
    }
    const current = view.domSelectionRange()
    if (
      current.anchorNode !== anchorNode ||
      current.anchorOffset !== anchorOffset ||
      current.focusNode !== focusNode ||
      current.focusOffset !== focusOffset
    ) {
      continue
    }
    if (ignored) {
      return false
    }

    const selection = view.state.selection
    if (!(selection instanceof TextSelection)) {
      const anchor = view.posAtDOM(anchorNode, anchorOffset)
      const head = view.posAtDOM(focusNode, focusOffset)
      // Structured selections render a native range too; only a different text gesture supersedes them.
      const presentation = TextSelection.between(selection.$anchor, selection.$head)
      if (
        (anchor === selection.anchor && head === selection.head) ||
        (anchor === presentation.anchor && head === presentation.head)
      ) {
        return false
      }
    }

    const anchor = view.posAtDOM(anchorNode, anchorOffset)
    const head = view.posAtDOM(focusNode, focusOffset)
    observer.stop()
    try {
      if (view.hasFocus() && !view.input.mouseDown?.allowDefault) {
        // Cached native endpoints can be unpublished. Let the engine classify them before acceptance.
        observer.currentSelection.clear()
        observer.onSelectionChange()
      } else {
        // Held/outgoing input still needs the engine reader beyond its ordinary focus/cache gates.
        observer.handleDOMChange(-1, -1, false, [])
      }
      if (
        !view.isDestroyed &&
        view.dom.isConnected &&
        !view.composing &&
        view.root.activeElement === owner &&
        view.state.doc === state.doc &&
        view.state.plugins === state.plugins &&
        !view.state.selection.eq(initialSelection) &&
        view.state.selection instanceof TextSelection &&
        view.state.selection.anchor === anchor &&
        view.state.selection.head === head &&
        anchorNode.isConnected &&
        focusNode.isConnected
      ) {
        // Restore native table highlighting only for this accepted publication and current owner.
        view.dom.ownerDocument
          .getSelection()
          ?.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
      }
      if (!view.isDestroyed) {
        observer.setCurSelection()
      }
    } finally {
      if (!view.isDestroyed) {
        observer.start()
      }
    }
    if (
      view.isDestroyed ||
      !view.dom.isConnected ||
      view.composing ||
      view.root.activeElement !== owner
    ) {
      return false
    }
    // Complete newly owed input in the current context, without replaying the previous endpoints.
    if (
      view.state.doc === state.doc &&
      view.state.plugins === state.plugins &&
      !observer.pendingRecords().length
    ) {
      return false
    }
  }
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
        filterTransaction(tr) {
          const mouseDown = viewRef?.input.mouseDown
          // Cell decorations force native selection rewrites during text drags (including Shift extension).
          return !(mouseDown?.allowDefault && tr.selection instanceof CellSelection)
        },
        view(editorView) {
          viewRef = selectionView(editorView)
          const observer = viewRef.domObserver
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
          const originalOnSelectionChange = observer.onSelectionChange
          doc.removeEventListener('selectionchange', originalOnSelectionChange)
          const patchedOnSelectionChange = (): void => {
            if (viewRef?.input.mouseDown?.allowDefault) {
              observer.setCurSelection()
              return
            }
            originalOnSelectionChange()
          }
          observer.onSelectionChange = patchedOnSelectionChange
          doc.addEventListener('selectionchange', patchedOnSelectionChange)
          return {
            destroy() {
              doc.removeEventListener('mouseup', completeNativeGesture, true)
              doc.removeEventListener('mousemove', completeNativeGesture, true)
              doc.removeEventListener('selectionchange', patchedOnSelectionChange)
              observer.onSelectionChange = originalOnSelectionChange
              doc.addEventListener('selectionchange', originalOnSelectionChange)
              // Plugin views die after observer disconnect; retain live reconfiguration without leaking on destruction.
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
