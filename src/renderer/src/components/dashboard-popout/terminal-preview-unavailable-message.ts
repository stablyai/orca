import { translate } from '@/i18n/i18n'
import type { DashboardCardHostKind } from '../../../../shared/dashboard-snapshot'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'

/** Remote snapshot absence cannot prove pane exit because the client does not own the PTY; see docs/reference/ssh-execution-boundary.md. */
export function terminalPreviewUnavailableMessage(source: {
  ptyId?: string | null
  hostKind?: DashboardCardHostKind
}): string {
  const isRemote =
    source.hostKind === 'ssh' ||
    source.hostKind === 'remote' ||
    isRemoteRuntimePtyId(source.ptyId) ||
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
