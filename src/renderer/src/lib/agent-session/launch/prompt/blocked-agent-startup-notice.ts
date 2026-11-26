import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export function notifyBlockedAgentStartup(
  reason: 'unknown' | 'unavailable',
  request: string | undefined
): void {
  toast.message(
    reason === 'unavailable'
      ? translate('terminal.agentStartup.unavailable', 'The agent could not be found on this host.')
      : translate(
          'terminal.agentStartup.unknown',
          'The host could not verify the agent installation.'
        ),
    request ? copyDroppedTextAction(request) : undefined
  )
}

export function copyDroppedTextAction(text: string): {
  action: { label: string; onClick: () => void }
} {
  return {
    action: {
      label: translate('menu.copy', 'Copy'),
      onClick: () => {
        void window.api.ui.writeClipboardText(text)
      }
    }
  }
}
