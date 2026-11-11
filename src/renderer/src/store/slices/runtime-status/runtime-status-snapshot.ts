import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeHostStatusSnapshot,
  type RuntimeEnvironmentStatus
} from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatusSlice, RuntimeStatusStoreState } from './runtime-status-types'

import { ensureBrowserClientHostsForRestoredPages } from '@/runtime/browser/client-hosting/restored-client-hosted-browser-host-attach'
import { replayClientHostedBrowserCloseIntents } from '@/runtime/browser/closing/client-hosted-browser-close-intent-replay'

/** A snapshot’s newer pairing revision signals a CLI update/rollback the renderer catalog missed (P1-C). */
export function snapshotOutrunsCatalog(
  snapshot: RuntimeHostStatusSnapshot,
  state: Pick<RuntimeStatusSlice, 'runtimeEnvironments'>
): boolean {
  const environment = state.runtimeEnvironments.find((entry) => entry.id === snapshot.environmentId)
  return (
    environment !== undefined &&
    snapshot.pairingRevision > (environment.pairingRevision ?? environment.createdAt)
  )
}

export function applyRuntimeHostStatusSnapshot(
  snapshot: RuntimeHostStatusSnapshot,
  state: RuntimeStatusStoreState,
  publishEvidence: (entry: RuntimeEnvironmentStatus) => void
): void {
  const environment = state.runtimeEnvironments.find((entry) => entry.id === snapshot.environmentId)
  if (
    !environment ||
    (environment.pairingRevision ?? environment.createdAt) !== snapshot.pairingRevision
  ) {
    return
  }
  const previous = state.runtimeStatusByEnvironmentId.get(snapshot.environmentId)
  if (previous?.snapshot && previous.snapshot.sequence >= snapshot.sequence) {
    return
  }
  const entry: RuntimeEnvironmentStatus = {
    ...runtimeEnvironmentStatusFromSnapshot(snapshot),
    connectionGeneration: previous?.connectionGeneration,
    hostContactEpoch: previous?.hostContactEpoch
  }
  if (entry.status) {
    state.setRuntimeEnvironmentStatus(snapshot.environmentId, entry)
    if (previous?.status == null) {
      void ensureBrowserClientHostsForRestoredPages(state)
      void replayClientHostedBrowserCloseIntents(snapshot.environmentId, {
        clientHostedBrowserCloseIntentsByEnvironment:
          state.clientHostedBrowserCloseIntentsByEnvironment,
        clearClientHostedBrowserCloseIntents: state.clearClientHostedBrowserCloseIntents
      })
    }
  } else {
    // Lost contact or a failed method observes no runtime session ending.
    publishEvidence(entry)
  }
}
