import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export async function copyMarkdownDocument(content: string): Promise<boolean> {
  try {
    await window.api.ui.writeClipboardText(content)
    return true
  } catch {
    toast.error(
      translate('auto.components.editor.markdownHeaderCopy.copyFailed', 'Failed to copy markdown')
    )
    return false
  }
}
