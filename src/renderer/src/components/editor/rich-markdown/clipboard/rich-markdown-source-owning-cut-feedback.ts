import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export function showRichMarkdownSourceOwningCutLimitError(): void {
  toast.error(
    translate(
      'auto.components.editor.richMarkdownSourceOwningCutFeedback.selectLessContent',
      'Select less content or use code mode to cut preserved HTML citations.'
    )
  )
}
