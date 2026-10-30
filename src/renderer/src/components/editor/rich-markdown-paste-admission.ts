import type { EditorView } from '@tiptap/pm/view'
import {
  handleRichMarkdownImagePaste,
  type RichMarkdownImagePasteArgs
} from './rich-markdown-paste-image'
import { handleRichMarkdownLargeTextPaste } from './rich-markdown-large-text-paste'

export function handleRichMarkdownPasteAdmission({
  view,
  ...args
}: RichMarkdownImagePasteArgs & { view: EditorView }): boolean {
  const { editor, event } = args
  if (event.defaultPrevented || !editor || !editor.isEditable || !view.editable || view.composing) {
    return false
  }
  if (handleRichMarkdownImagePaste(args)) {
    return true
  }
  const html = event.clipboardData?.getData('text/html') ?? ''
  // Citation source preservation needs the existing parsed-slice validation and aggregate limits.
  if (/data-rich-markdown-html-superscript-link/i.test(html)) {
    return false
  }
  return handleRichMarkdownLargeTextPaste(editor, event)
}
