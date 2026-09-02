import type { Editor } from '@tiptap/react'
import type { Slice } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { handleRichMarkdownImagePaste } from './rich-markdown-paste-image'
import { handleRichMarkdownLargeTextPaste } from './rich-markdown-large-text-paste'
import { handleRichMarkdownTerminalPathPaste } from './rich-markdown-terminal-path-paste'
import { inspectRichMarkdownSourceOwningSlice } from './rich-markdown-source-owning-slice'
import { getRichMarkdownVisibleText } from './rich-markdown-visible-text-map'

export type RichMarkdownPasteHandlerArgs = {
  editor: Editor | null
  event: ClipboardEvent
  filePath: string
  worktreeId: string
  runtimeEnvironmentId?: string | null
  slice?: Slice
  view?: EditorView
}

export function handleRichMarkdownPaste({
  editor,
  event,
  filePath,
  worktreeId,
  runtimeEnvironmentId,
  slice,
  view
}: RichMarkdownPasteHandlerArgs): boolean {
  if (
    handleRichMarkdownImagePaste({
      editor,
      event,
      filePath,
      worktreeId,
      runtimeEnvironmentId
    })
  ) {
    return true
  }

  const sourceOwningStatus = slice ? inspectRichMarkdownSourceOwningSlice(slice) : null
  if (sourceOwningStatus?.containsSourceOwningNode && slice && view) {
    if (sourceOwningStatus.canPreserve) {
      // Why: dispatch directly so the transaction can carry paste/uiEvent
      // metadata that editor.commands.insertContent would omit.
      view.dispatch(
        view.state.tr
          .replaceSelection(slice)
          .setMeta('paste', true)
          .setMeta('uiEvent', 'paste')
          .scrollIntoView()
      )
      return true
    }
    const visibleText = getRichMarkdownVisibleText(slice.content)
    if (
      handleRichMarkdownLargeTextPaste(editor, event, {
        plainTextOverride: visibleText,
        htmlTextOverride: ''
      })
    ) {
      return true
    }
    if (visibleText && editor) {
      event.preventDefault()
      editor.commands.insertContent(visibleText)
    }
    return true
  }

  if (handleRichMarkdownTerminalPathPaste(editor, event)) {
    return true
  }

  return handleRichMarkdownLargeTextPaste(editor, event)
}
