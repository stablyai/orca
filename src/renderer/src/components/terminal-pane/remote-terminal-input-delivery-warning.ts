import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export function warnRemoteTerminalInputDelivery(environmentId: string, terminal: string): void {
  toast.warning(
    translate('terminal.inputDeliveryUncertain', 'Remote terminal input delivery is uncertain'),
    {
      id: `remote-terminal-input:${environmentId}:${terminal}`,
      description: translate(
        'terminal.inputDeliveryUncertainDescription',
        'Some input may not have reached the host. Check the terminal before retrying a command.'
      ),
      duration: Infinity,
      closeButton: true
    }
  )
}
