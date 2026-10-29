/** The macOS Local Network warning for a server whose launching SSH session ended (#25934). */
import { translate } from '@/i18n/i18n'
import type { SshHostServerStatusLine } from './ssh-host-server-status-copy'

export function launchSessionEndedLine(): SshHostServerStatusLine {
  return {
    tone: 'warning',
    text: translate(
      'auto.components.settings.sshHostServer.launchSessionEnded',
      'Terminals on this Mac may have lost local network access because the SSH session that started this host’s Orca server ended. Restart Orca’s server to restore it.'
    )
  }
}
