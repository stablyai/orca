import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { RuntimeHostBlockedReason } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimePairingRepairRoute } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeCompatVerdict } from '../../../../shared/protocol-compat'
import { describeRuntimeCompatBlock } from '@/lib/runtime-host-copy'
import '@/runtime/hosts/connections/runtime-host-connection-state'
import {
  runtimeStatusForOverall,
  type HostStatus,
  type RuntimeHostConnectionState
} from '../../../../shared/remote-runtime/host-status/runtime-host-connection-state'
import { isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'

/** 'blocked' is a host that refused us (revoked pairing or incompatible versions). */
export type OverallHostStatus = HostStatus | 'blocked'

export function sshStatusForOverall(status: SshConnectionStatus): HostStatus {
  if (status === 'connected') {
    return 'connected'
  }
  return isConnectingSshStatus(status) ? 'connecting' : 'disconnected'
}

export function runtimeHostStatusForOverall(
  state: RuntimeHostConnectionState,
  blockedReason: RuntimeHostBlockedReason | undefined
): OverallHostStatus {
  return blockedReason ? 'blocked' : runtimeStatusForOverall(state)
}

export type RuntimeHostBlockedCopy = {
  label: string
  summary: string
  /** Untranslated protocol detail, copied only on request. */
  detail?: string
}

/** `repair`: a new access link re-pairs; `open-settings`: the server must be forgotten there first. */
export type RuntimeHostBlockedRecovery = 'repair' | 'open-settings'

/** The row action that can actually get a refused host back; null when only another surface can. */
export function runtimeHostBlockedRecovery(
  reason: RuntimeHostBlockedReason,
  repairRoute: RuntimePairingRepairRoute
): RuntimeHostBlockedRecovery | null {
  if (reason === 'server-replaced') {
    // Why not Connect: SSH access alone can't pair with the host's new server key.
    return 'open-settings'
  }
  return reason === 'access-revoked' && repairRoute === 'access-link' ? 'repair' : null
}

export function runtimeHostBlockedCopy(
  reason: RuntimeHostBlockedReason,
  compatibility?: RuntimeCompatVerdict,
  repairRoute: RuntimePairingRepairRoute = 'access-link',
  t: Translate = translate
): RuntimeHostBlockedCopy {
  if (reason === 'access-revoked') {
    return {
      label: t('auto.components.status.bar.RuntimeHostStatusRow.access_revoked', 'Access revoked'),
      summary:
        repairRoute === 'access-link'
          ? t(
              'auto.components.status.bar.RuntimeHostStatusRow.access_revoked_explanation',
              'Re-pair with a new pairing link from the server to reconnect.'
            )
          : repairRoute === 'ssh'
            ? t(
                'auto.components.status.bar.RuntimeHostStatusRow.managed_access_revoked_explanation',
                "Orca couldn't pair with it again over SSH; connect to try again."
              )
            : t(
                'auto.components.status.bar.RuntimeHostStatusRow.connect_access_revoked_explanation',
                'Connect to try again.'
              )
    }
  }
  if (reason === 'server-replaced') {
    return {
      label: t(
        'auto.components.status.bar.RuntimeHostStatusRow.server_replaced',
        'Different server'
      ),
      summary: t(
        'auto.components.status.bar.RuntimeHostStatusRow.server_replaced_explanation',
        'In Settings › Remote Orca Servers, choose Forget… for this server, then connect the SSH host to pair with its current server.'
      )
    }
  }
  return {
    label: t('auto.components.status.bar.RuntimeHostStatusRow.update_required', 'Update required'),
    summary: t(
      'auto.components.status.bar.RuntimeHostStatusRow.update_required_explanation',
      'Update Orca on this computer or on the server, then connect again.'
    ),
    ...(compatibility?.kind === 'blocked'
      ? { detail: describeRuntimeCompatBlock(compatibility, t) }
      : {})
  }
}

export function ambiguousRemoteHostNames(
  servers: readonly { label: string }[],
  sshHosts: readonly { label: string }[]
): ReadonlySet<string> {
  const serverNames = new Set(servers.map((host) => host.label))
  return new Set(sshHosts.filter((host) => serverNames.has(host.label)).map((host) => host.label))
}
