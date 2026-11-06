import {
  runtimePairingRepairRoute,
  type PublicKnownRuntimeEnvironment,
  type RuntimePairingRepairRoute
} from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { resolveHostDisplay } from '../../../../../../shared/host-display-resolution'
import { lastVerifiedRuntimeStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../../../../shared/runtime-session-contracts'
import { translate } from '@/i18n/i18n'
import { runtimeHostConnectionStateForEntry } from '@/runtime/runtime-host-connection-state'
import {
  isConnectedRuntimeHostState,
  type RuntimeHostConnectionState as RuntimeServerConnectionState
} from '../../../../../../shared/remote-runtime/host-status/runtime-host-connection-state'
import { useAppStore } from '@/store/index'
import {
  evaluateHostDetails,
  getHostDetailsDescription,
  getRuntimeServerConnectionState,
  isRuntimeServerTransportConnected,
  type RuntimeHostDetails
} from '../catalog/runtime-environment-host-details'

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
  /** The host now runs a different server that refuses this computer's pairing. */
  serverReplaced: boolean
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
  // Share the host verdict across Settings surfaces: an unverifiable probe can leave transport connected, so raw entry.status would offer Connect while repository setup still reports reachability.
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
  // Keep last verified descriptors across lost probes; latest status alone can be absent.
  const descriptorStatus = lastVerifiedRuntimeStatus(runtimeStatusEntry)
  const hostDisplay = resolveHostDisplay({
    name: environment.name,
    machineName: descriptorStatus?.machineName,
    platform: descriptorStatus?.hostPlatform
  })
  const serverReplaced =
    snapshot?.verification === 'blocked' &&
    !snapshot.retired &&
    snapshot.blockedReason === 'server-replaced'
  const compatibilityBlocked =
    !accessRevoked && !serverReplaced && effectiveDetails?.compatibility?.kind === 'blocked'
  return {
    effectiveDetails,
    connectionState,
    isReachable,
    accessRevoked,
    repairRoute,
    problem: accessRevoked
      ? getRevokedDescription(environment.name, repairRoute)
      : serverReplaced
        ? translate(
            'auto.components.settings.RuntimeEnvironmentsPane.serverReplaced',
            '{{value0}} is not the Orca server this computer paired with: Orca connects to the host as a different SSH user, or its server was reinstalled. Open the ⋯ menu here and choose Forget…, then connect the SSH host to pair with its current server.',
            { value0: environment.name }
          )
        : getHostDetailsDescription(effectiveDetails),
    probeFailed:
      !isReachable && effectiveDetails?.status === 'error' && Boolean(effectiveDetails.error),
    compatibilityBlocked,
    serverReplaced,
    descriptorStatus,
    hostDescriptorText: hostDisplay.descriptorLine,
    title: hostDisplay.title
  }
}

function getRevokedDescription(name: string, repairRoute: RuntimePairingRepairRoute): string {
  if (repairRoute === 'ssh') {
    // Managed SSH pairing normally happens automatically; reaching this error means it failed.
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
