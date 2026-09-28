import { toast } from 'sonner'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'

async function copyWithToast(text: string, label: string): Promise<void> {
  await window.api.ui.writeClipboardText(text)
  toast.success(
    translate('auto.components.right.sidebar.AiVaultPanel.valueCopied', '{{value0}} copied', {
      value0: label
    })
  )
}

export function copyAiVaultSessionId(session: AiVaultSession): Promise<void> {
  return copyWithToast(
    session.sessionId,
    translate('auto.components.right.sidebar.AiVaultPanel.sessionId', 'Session ID')
  )
}

export function copyAiVaultSessionLogPath(session: AiVaultSession): Promise<void> {
  return copyWithToast(
    session.filePath,
    translate('auto.components.right.sidebar.AiVaultPanel.logPath', 'Log path')
  )
}
