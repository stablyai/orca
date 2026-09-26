import type { Editor } from '@tiptap/react'
import type { TerminalRichInputImageAttachment } from './terminal-rich-input-types'
import type { TerminalRichInputSubmitResult } from './terminal-rich-input-submit'
import { terminalRichInputRemoveSubmittedContent } from './terminal-rich-input-model'

export function removeWrittenTerminalRichInputContent(
  result: Extract<TerminalRichInputSubmitResult, { status: 'partially-written' }>,
  attachments: readonly TerminalRichInputImageAttachment[],
  editor: Editor
): void {
  // A retry must contain only stages that never reached the PTY.
  const writtenAttachments = attachments.slice(0, result.imagePathsWritten)
  if (writtenAttachments.length > 0 || result.textWritten) {
    editor.commands.setContent(
      terminalRichInputRemoveSubmittedContent(
        editor.getJSON(),
        writtenAttachments.map((attachment) => attachment.id),
        result.textWritten
      ),
      { emitUpdate: true }
    )
  }
}
