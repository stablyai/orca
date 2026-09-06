import type { Editor } from '@tiptap/react'
import type { TerminalRichInputImageAttachment } from './terminal-rich-input-types'
import {
  terminalRichInputContentToText,
  terminalRichInputRemoveSubmittedContent
} from './terminal-rich-input-model'
import { removeWrittenTerminalRichInputContent } from './terminal-rich-input-submit-reconcile'
import type { TerminalRichInputSubmitResult } from './terminal-rich-input-submit'

export async function submitTerminalRichInputEditor({
  draft,
  attachments,
  editor,
  onSubmit,
  inlineImageText
}: {
  draft: string
  attachments: readonly TerminalRichInputImageAttachment[]
  editor: Editor
  onSubmit: (text: string, imagePaths: string[]) => Promise<TerminalRichInputSubmitResult>
  inlineImageText?: (imagePath: string) => string
}): Promise<TerminalRichInputSubmitResult> {
  editor.setEditable(false)
  let result: TerminalRichInputSubmitResult = { status: 'not-started' }
  try {
    result = await onSubmit(
      inlineImageText ? terminalRichInputContentToText(editor.getJSON(), inlineImageText) : draft,
      inlineImageText ? [] : attachments.map((attachment) => attachment.path)
    )
  } catch {
    result = { status: 'not-started' }
  }
  editor.setEditable(true)
  if (result.status === 'partially-written') {
    const reconciledResult =
      inlineImageText && result.textWritten
        ? { ...result, imagePathsWritten: attachments.length }
        : result
    removeWrittenTerminalRichInputContent(reconciledResult, attachments, editor)
    editor.commands.focus('end')
    return reconciledResult
  }
  if (result.status !== 'submitted') {
    editor.commands.focus('end')
    return result
  }

  const submittedIds = attachments.map((attachment) => attachment.id)
  editor.commands.setContent(
    terminalRichInputRemoveSubmittedContent(editor.getJSON(), submittedIds, true),
    { emitUpdate: true }
  )
  editor.commands.focus('end')
  return result
}
