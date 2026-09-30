import { translate } from '@/i18n/i18n'
import type { DashboardCardHostKind } from '../../../../shared/dashboard-snapshot'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'

/**
 * A missing buffer snapshot only proves the pane exited when the client could have
 * observed it. `SshPtyProvider` reports no authoritative buffer snapshot and the relay
 * exposes no snapshot RPC, so for a remote pty the absence is loss of contact —
 * `unverifiable`, never `exited`. See docs/reference/ssh-execution-boundary.md.
 */
export function terminalPreviewUnavailableMessage(source: {
  ptyId?: string | null
  hostKind?: DashboardCardHostKind
}): string {
  const isRemote =
    source.hostKind === 'ssh' ||
    (typeof source.ptyId === 'string' && parseAppSshPtyId(source.ptyId) !== null)
  return isRemote
    ? translate(
        'dashboardPopout.terminal.remotePreviewUnavailable',
        'No preview for this remote session — open the workspace to view the terminal.'
      )
    : translate(
        'dashboardPopout.terminal.closed',
        "No live terminal — this agent's pane has closed."
      )
}
