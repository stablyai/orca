import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export function showRichMarkdownImageInsertionCanceled(importedFileKept = false): void {
  toast.info(
    importedFileKept
      ? translate(
          'auto.components.editor.richMarkdownImageInsertionFeedback.importedFileKept',
          'Image insertion canceled because the destination changed. The imported file was kept.'
        )
      : translate(
          'auto.components.editor.richMarkdownImageInsertionFeedback.destinationChanged',
          'Image insertion canceled because the destination changed. Try again.'
        )
  )
}
