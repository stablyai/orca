import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import type { AppState } from '../types'
import type { RuntimeEnvironmentStatus } from './runtime-status-types'
import { ensureBrowserClientHostsForRestoredPages } from '@/runtime/restored-client-hosted-browser-host-attach'
import { replayClientHostedBrowserCloseIntents } from '@/runtime/client-hosted-browser-close-intent-replay'

export function applyRuntimeHostStatusSnapshot(
  snapshot: RuntimeHostStatusSnapshot,
  state: AppState,
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
    snapshot,
    checkedAt: snapshot.checkedAt,
    connectionGeneration: previous?.connectionGeneration,
    hostContactEpoch: previous?.hostContactEpoch,
    status: snapshot.verification === 'verified' && !snapshot.retired ? snapshot.status : null,
    remoteControl: snapshot.remoteControl
  }
  if (entry.status) {
    if (snapshot.remoteControl) {
      entry.status = { ...entry.status, remoteControl: snapshot.remoteControl }
    }
    state.setRuntimeEnvironmentStatus(snapshot.environmentId, entry)
    if (previous?.status == null) {
      void ensureBrowserClientHostsForRestoredPages(state)
      void replayClientHostedBrowserCloseIntents(snapshot.environmentId, state)
    }
  } else {
    // Lost contact or a failed method observes no runtime session ending.
    publishEvidence(entry)
  }
}
