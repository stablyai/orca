import {
  runtimePairingRepairRoute,
  type PublicKnownRuntimeEnvironment,
  type RuntimePairingRepairRoute
} from '../../../../shared/runtime-environments'
import { resolveHostDisplay } from '../../../../shared/host-display-resolution'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { translate } from '@/i18n/i18n'
import {
  isConnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry
} from '@/runtime/runtime-host-connection-state'
import { useAppStore } from '@/store'
import {
  evaluateHostDetails,
  getHostDetailsDescription,
  getRuntimeServerConnectionState,
  isRuntimeServerTransportConnected,
  type RuntimeHostDetails,
  type RuntimeServerConnectionState
} from './runtime-environment-host-details'

export type RuntimeServerRowState = {
  effectiveDetails: RuntimeHostDetails | undefined
  connectionState: RuntimeServerConnectionState
  isReachable: boolean
  accessRevoked: boolean
  repairRoute: RuntimePairingRepairRoute
  /** What went wrong, in full; the row truncates it to one line. */
  problem: string | null
  probeFailed: boolean
  compatibilityBlocked: boolean
  /** Last answered status, kept across a lost probe. */
  descriptorStatus: RuntimeStatus | null | undefined
  hostDescriptorText: string | null
  title: string
}

export function useRuntimeServerRowState(
  environment: PublicKnownRuntimeEnvironment,
  details: RuntimeHostDetails | undefined
): RuntimeServerRowState {
  const runtimeStatusEntry = useAppStore((state) =>
    state.runtimeStatusByEnvironmentId.get(environment.id)
  )
  // Why the shared verdict and not `entry.status`: an unverifiable probe nulls it while the
  // transport is still up, and this row then read "error" and offered Connect for a host that
  // RepositoryHostSetupsSection -- which already derives through this same function -- was
  // showing as reachable. One host, two surfaces, opposite answers. A probe that did not come
  // back is not a host that went away (docs/reference/ssh-execution-boundary.md).
  const entryReachable =
    runtimeStatusEntry !== undefined &&
    isConnectedRuntimeHostState(runtimeHostConnectionStateForEntry(runtimeStatusEntry))
  const effectiveDetails: RuntimeHostDetails | undefined = runtimeStatusEntry
    ? {
        ...(details ?? {
          status: entryReachable ? 'ready' : 'error',
          runtimeStatus: null,
          compatibility: null,
          error: null
        }),
        status: entryReachable ? 'ready' : 'error',
        runtimeStatus: runtimeStatusEntry.status,
        compatibility: runtimeStatusEntry.status
          ? evaluateHostDetails(runtimeStatusEntry.status)
          : null,
        remoteControl:
          runtimeStatusEntry.remoteControl ?? runtimeStatusEntry.status?.remoteControl ?? null
      }
    : details
  const snapshot = runtimeStatusEntry?.snapshot
  const accessRevoked =
    snapshot?.verification === 'blocked' &&
    !snapshot.retired &&
    snapshot.blockedReason === 'access-revoked'
  const repairRoute = runtimePairingRepairRoute(environment)
  const connectionState =
    details?.status === 'loading' && !runtimeStatusEntry?.status
      ? 'checking'
      : getRuntimeServerConnectionState(effectiveDetails)
  const isReachable = isRuntimeServerTransportConnected(connectionState)
  // Why: the snapshot keeps the last answered status across a lost probe; `status` is only the latest answer.
  const descriptorStatus = lastVerifiedRuntimeStatus(runtimeStatusEntry)
  const hostDisplay = resolveHostDisplay({
    name: environment.name,
    machineName: descriptorStatus?.machineName,
    platform: descriptorStatus?.hostPlatform
  })
  const compatibilityBlocked = !accessRevoked && effectiveDetails?.compatibility?.kind === 'blocked'
  return {
    effectiveDetails,
    connectionState,
    isReachable,
    accessRevoked,
    repairRoute,
    problem: accessRevoked
      ? getRevokedDescription(environment.name, repairRoute)
      : getHostDetailsDescription(effectiveDetails),
    probeFailed:
      !isReachable && effectiveDetails?.status === 'error' && Boolean(effectiveDetails.error),
    compatibilityBlocked,
    descriptorStatus,
    hostDescriptorText: hostDisplay.descriptorLine,
    title: hostDisplay.title
  }
}

function getRevokedDescription(name: string, repairRoute: RuntimePairingRepairRoute): string {
  if (repairRoute === 'ssh') {
    // Why: Orca pairs a managed server over SSH by itself; it reaches here only when that failed.
    return translate(
      'auto.components.settings.RuntimeEnvironmentsPane.managedAccessRevoked',
      "{{value0}} no longer accepts this computer, and Orca couldn't pair with it again over SSH. Connect to try again.",
      { value0: name }
    )
  }
  if (repairRoute === 'connect') {
    return translate(
      'auto.components.settings.RuntimeEnvironmentsPane.connectAccessRevoked',
      '{{value0}} no longer accepts this computer. Connect to try again.',
      { value0: name }
    )
  }
  return translate(
    'auto.components.settings.RuntimeEnvironmentsPane.accessRevoked',
    '{{value0}} no longer accepts this computer. Re-pair it with a new access link.',
    { value0: name }
  )
}
