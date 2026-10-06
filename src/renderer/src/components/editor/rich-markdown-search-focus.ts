import type { EditorView } from '@tiptap/pm/view'
import { CellSelection } from '@tiptap/pm/tables'

export function focusRichMarkdownEditorFromSearch(
  event: MouseEvent,
  view: Pick<EditorView, 'dom' | 'focus' | 'state'> | null
): void {
  if (
    !view ||
    event.button !== 0 ||
    (event.defaultPrevented && !(view.state.selection instanceof CellSelection))
  ) {
    return
  }

  const editorDom = view.dom
  const target = event.target
  if (!(target instanceof Element) || !editorDom.contains(target)) {
    return
  }

  const root = editorDom.closest('.rich-markdown-editor-shell')
  const activeElement = editorDom.ownerDocument.activeElement
  if (
    !root ||
    !activeElement?.closest('.rich-markdown-search') ||
    activeElement.closest('.rich-markdown-editor-shell') !== root
  ) {
    return
  }

  const control = target.closest('button, input, textarea, select, [contenteditable="false"]')
  if (control && editorDom.contains(control)) {
    return
  }

  if (event.shiftKey || event.defaultPrevented) {
    // Shift extends the current selection; handled cell selection has no browser default.
    view.focus()
  } else {
    // Native focus preserves the browser's upcoming click or drag selection.
    editorDom.focus({ preventScroll: true })
  }
}
