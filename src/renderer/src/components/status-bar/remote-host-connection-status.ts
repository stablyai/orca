import { translate } from '@/i18n/i18n'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import type { RuntimeHostBlockedReason } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimePairingRepairRoute } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeCompatVerdict } from '../../../../shared/protocol-compat'
import { describeRuntimeCompatBlock } from '@/lib/runtime-host-copy'
import '@/runtime/runtime-host-connection-state'
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
  explanation: string
  /** Untranslated protocol detail, shown in the diagnostics box. */
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
  repairRoute: RuntimePairingRepairRoute = 'access-link'
): RuntimeHostBlockedCopy {
  if (reason === 'access-revoked') {
    return {
      label: translate(
        'auto.components.status.bar.RuntimeHostStatusRow.access_revoked',
        'Access revoked'
      ),
      summary: translate(
        'auto.components.status.bar.RuntimeHostStatusRow.access_revoked_summary',
        'This server revoked access for this computer'
      ),
      // Why: Orca pairs a managed server over SSH by itself; it reaches here only when that failed.
      explanation:
        repairRoute === 'access-link'
          ? translate(
              'auto.components.status.bar.RuntimeHostStatusRow.access_revoked_explanation',
              'Re-pair with a new pairing link from the server to reconnect.'
            )
          : repairRoute === 'ssh'
            ? translate(
                'auto.components.status.bar.RuntimeHostStatusRow.managed_access_revoked_explanation',
                "Orca couldn't pair with it again over SSH. Connect to try again."
              )
            : translate(
                'auto.components.status.bar.RuntimeHostStatusRow.connect_access_revoked_explanation',
                'Connect to try again.'
              )
    }
  }
  if (reason === 'server-replaced') {
    return {
      label: translate(
        'auto.components.status.bar.RuntimeHostStatusRow.server_replaced',
        'Different server'
      ),
      summary: translate(
        'auto.components.status.bar.RuntimeHostStatusRow.server_replaced_summary',
        'This host now runs a different Orca server than the one this computer paired with'
      ),
      // Why: SSH access alone can't re-pin another server key, so reconnecting can't fix this.
      explanation: translate(
        'auto.components.status.bar.RuntimeHostStatusRow.server_replaced_explanation',
        'Orca connects to the host as a different SSH user, or its server was reinstalled. In Settings › Remote Orca Servers, open the ⋯ menu on this server and choose Forget…, then connect the SSH host to pair with its current server.'
      )
    }
  }
  return {
    label: translate(
      'auto.components.status.bar.RuntimeHostStatusRow.update_required',
      'Update required'
    ),
    summary: translate(
      'auto.components.status.bar.RuntimeHostStatusRow.update_required_summary',
      'Orca versions are not compatible'
    ),
    explanation: translate(
      'auto.components.status.bar.RuntimeHostStatusRow.update_required_explanation',
      'Update Orca on this computer or on the server, then connect again.'
    ),
    ...(compatibility?.kind === 'blocked'
      ? { detail: describeRuntimeCompatBlock(compatibility) }
      : {})
  }
}

export function runtimeHostConnectionDetail(
  remoteControl?: RemoteRuntimeSharedConnectionDiagnostics | null
): string | undefined {
  if (!remoteControl) {
    return undefined
  }
  if (
    remoteControl.state === 'awaiting_ready' ||
    remoteControl.state === 'awaiting_authenticated'
  ) {
    return undefined
  }
  if (remoteControl.state === 'reconnecting') {
    return translate(
      'auto.components.status.bar.SshStatusSegment.runtime_reconnect_attempt',
      'Attempt {{value0}}',
      { value0: String(remoteControl.reconnectAttempt + 1) }
    )
  }
  if (remoteControl.lastError) {
    return remoteControl.lastError
  }
  if (remoteControl.lastClose?.reason) {
    return translate(
      'auto.components.status.bar.SshStatusSegment.runtime_last_close_reason',
      'Closed: {{value0}}',
      { value0: remoteControl.lastClose.reason }
    )
  }
  // Hide internal RPC counts; only errors, close reasons and reconnect attempts help users act.
  return undefined
}
