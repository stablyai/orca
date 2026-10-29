/**
 * COMPAT(legacy-relay-bridge, revisit 2027-01-15): a host kept unmoved, and connected, because the
 * bridge still serves relay terminals in a project its managed server already holds.
 */
import { translate } from '@/i18n/i18n'
import type { SshHostServerStatusLine } from './ssh-host-server-status-copy'

/** `detail` is main's English naming the project those terminals hold, so it stays behind "Details". */
export function bridgedTerminalsLine(detail: string | undefined): SshHostServerStatusLine {
  return {
    tone: 'warning',
    text: translate(
      'auto.components.settings.sshHostServer.olderTerminalsBridged',
      'Orca isn’t set up on this host yet: terminals started by an older version of Orca are still running in this host’s projects. They keep working here. Close them or end them on the host, then reconnect.'
    ),
    ...(detail ? { detail } : {})
  }
}
