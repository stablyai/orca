import { translate } from '@/i18n/i18n'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import type { RuntimeHostBlockedReason } from '../../../../shared/runtime-host-status'
import type { RuntimePairingRepairRoute } from '../../../../shared/runtime-environments'
import {
  describeRuntimeCompatBlock,
  type RuntimeCompatVerdict
} from '../../../../shared/protocol-compat'
import {
  runtimeStatusForOverall,
  type HostStatus,
  type RuntimeHostConnectionState
} from '@/runtime/runtime-host-connection-state'
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
  // Why: pending-request / subscription counts are internal RPC plumbing (e.g. a
  // live browser screencast shows as "N streams"). They're noise in a user-facing
  // status row and make the line truncate — only surface actionable detail
  // (errors, close reasons, reconnect attempts) above.
  return undefined
}
