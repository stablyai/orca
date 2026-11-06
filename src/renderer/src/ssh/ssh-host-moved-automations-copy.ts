import { translate } from '@/i18n/i18n'
import type { SshHostServerStatusLine } from './ssh-host-server-status-copy'

/** A move took these automations but the server couldn't turn them back on. */
export function automationsLeftDisabledLine(count: number): SshHostServerStatusLine {
  return {
    tone: 'warning',
    text: translate(
      'auto.components.settings.sshHostServer.automationsLeftDisabled',
      'This host’s Orca server took over {{count}} automations but couldn’t turn them back on. Turn them on in Automations.',
      {
        count,
        defaultValue_one:
          'This host’s Orca server took over {{count}} automation but couldn’t turn it back on. Turn it on in Automations.'
      }
    )
  }
}
