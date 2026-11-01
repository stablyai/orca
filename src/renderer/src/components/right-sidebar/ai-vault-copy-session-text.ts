import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export async function copyAiVaultSessionText(text: string, label: string): Promise<void> {
  await window.api.ui.writeClipboardText(text)
  toast.success(
    translate('auto.components.right.sidebar.AiVaultPanel.valueCopied', '{{value0}} copied', {
      value0: label
    })
  )
}
