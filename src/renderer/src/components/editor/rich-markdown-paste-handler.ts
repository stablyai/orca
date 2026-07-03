import type { Editor } from '@tiptap/react'
import { handleRichMarkdownImagePaste } from './rich-markdown-paste-image'
import { handleRichMarkdownLargeTextPaste } from './rich-markdown-large-text-paste'
import { handleRichMarkdownTerminalPathPaste } from './rich-markdown-terminal-path-paste'

export type RichMarkdownPasteHandlerArgs = {
  editor: Editor | null
  event: ClipboardEvent
  filePath: string
  worktreeId: string
  runtimeEnvironmentId?: string | null
}

export function handleRichMarkdownPaste({
  editor,
  event,
  filePath,
  worktreeId,
  runtimeEnvironmentId
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

  if (handleRichMarkdownTerminalPathPaste(editor, event)) {
    return true
  }

  return handleRichMarkdownLargeTextPaste(editor, event)
}
