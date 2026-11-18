import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export async function copyRichMarkdownLink(href: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(href)
    toast.success(
      translate('auto.components.editor.richMarkdownLinkClipboard.copiedLink', 'Copied link')
    )
  } catch {
    toast.error(
      translate(
        'auto.components.editor.richMarkdownLinkClipboard.copyLinkFailed',
        'Failed to copy link'
      )
    )
  }
}
