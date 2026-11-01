import type { EditorView } from '@tiptap/pm/view'
import type { Editor } from '@tiptap/core'
import { completeRichMarkdownSelection } from './drag-selection-guard'

export function prepareRichMarkdownSearchClose(
  editor: Editor | null,
  searchInput: HTMLElement | null
): void {
  if (!editor || editor.isDestroyed || !editor.view.dom.isConnected) {
    return
  }
  const view = editor.view
  const panel = searchInput?.closest('.rich-markdown-search')
  if (panel?.contains(view.root.activeElement)) {
    view.focus()
  } else if (view.hasFocus()) {
    // Capture-handled Escape bypasses the editor's keydown completion before highlights are removed.
    completeRichMarkdownSelection(view)
  }
}

export function focusRichMarkdownEditorFromSearch(
  event: MouseEvent,
  view: Pick<EditorView, 'dom' | 'focus'> | null
): void {
  if (!view || event.button !== 0 || event.defaultPrevented) {
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

  // Restore the anchor before ProseMirror starts a native gesture that can defer selection sync.
  view.focus()
}
