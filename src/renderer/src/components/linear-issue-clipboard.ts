import { toast } from 'sonner'

import { translate } from '@/i18n/i18n'

export async function copyLinearIssueText(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.LinearIssueWorkspace.7835483c43', '{{value0}} copied', {
        value0: label
      })
    )
  } catch {
    toast.error(
      translate('auto.components.LinearIssueWorkspace.9bcbaa2737', 'Failed to copy {{value0}}', {
        value0: label.toLowerCase()
      })
    )
  }
}
