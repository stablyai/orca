import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { getOrcadSshDeployment } from '../../../../shared/runtime-environments'
import type { SshTarget } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import type { RuntimeServerRowState } from './runtime-server-row-state'

export type RuntimeServerProblemLine = { text: string; destructive: boolean }

/** How the row reaches the server when it isn't its plain network address. */
export function getRuntimeServerRoute(
  environment: PublicKnownRuntimeEnvironment,
  targets: SshTarget[]
): string | null {
  const targetLabel = (targetId: string): string =>
    targets.find((target) => target.id === targetId)?.label ?? targetId
  const deployment = getOrcadSshDeployment(environment)
  if (deployment) {
    // Why not the host: the row's title already names it.
    return translate('auto.components.settings.serverList.overYourSsh', 'Over your SSH connection')
  }
  if (environment.sshAccess) {
    return translate(
      'auto.components.settings.serverList.throughSsh',
      'Through {{host}} → port {{port}}',
      {
        host: targetLabel(environment.sshAccess.sshTargetId),
        port: environment.sshAccess.remotePort
      }
    )
  }
  return environment.connectionDependency === 'ssh-tunnel'
    ? translate(
        'auto.components.settings.RuntimeEnvironmentsPane.sshTunnelRequired',
        'SSH tunnel required'
      )
    : null
}

/**
 * The one line that replaces the row's info line, if anything needs saying.
 * Why "Last seen": the status column already says it's unreachable; the line says since when.
 */
export function getRuntimeServerProblemLine({
  environment,
  row,
  remoteUpdate,
  managedStatusError,
  managedSummary,
  address,
  duplicateOfNames = [],
  now = Date.now()
}: {
  environment: Pick<PublicKnownRuntimeEnvironment, 'lastUsedAt'>
  row: Pick<
    RuntimeServerRowState,
    'accessRevoked' | 'problem' | 'probeFailed' | 'compatibilityBlocked'
  >
  remoteUpdate: RemoteServerUpdateEntry | undefined
  managedStatusError: string | null
  managedSummary: string | null
  address: string | null
  /** Other saved servers with this one's host key: the same machine paired twice. */
  duplicateOfNames?: readonly string[]
  now?: number
}): RuntimeServerProblemLine | null {
  if (row.accessRevoked) {
    return { text: row.problem ?? '', destructive: true }
  }
  // Why before other problems: the twin makes this server's projects uneditable until one goes.
  if (duplicateOfNames.length > 0) {
    return {
      text: translate(
        'auto.components.settings.RuntimeEnvironmentsPane.pairedTwice',
        'Same server as {{value0}}, paired twice. Remove one so its projects can be edited.',
        { value0: duplicateOfNames[0] }
      ),
      destructive: true
    }
  }
  if (managedStatusError) {
    return { text: managedStatusError, destructive: true }
  }
  if (managedSummary) {
    return { text: managedSummary, destructive: false }
  }
  if (remoteUpdate?.phase === 'failed') {
    return {
      text: translate('auto.components.settings.RemoteServerUpdateStatus.failed', 'Update failed'),
      destructive: true
    }
  }
  if (row.probeFailed) {
    const when = environment.lastUsedAt
      ? translate('auto.components.settings.serverList.lastSeen', 'Last seen {{when}}', {
          when: formatUiRelativeTime(environment.lastUsedAt - now)
        })
      : translate('auto.components.settings.serverList.neverConnected', 'Never connected')
    // Why the address: it tells otherwise identical unreachable rows apart.
    return { text: address ? `${when} · ${address}` : when, destructive: false }
  }
  if (row.problem) {
    return { text: row.problem, destructive: row.compatibilityBlocked }
  }
  if (remoteUpdate?.phase === 'manual') {
    return {
      text: translate(
        'auto.components.settings.serverList.manualUpdate',
        'Update Orca on the server host'
      ),
      destructive: false
    }
  }
  return null
}
