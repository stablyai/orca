import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { agentSenderPublicationPatch } from '../agent-sender-associations'
import { isCurrentSessionTabsRuntimeFrame } from './publisher-identity-fences'
import { recordReceivedWebSessionTabsSnapshot } from './tracking'
import { isHostMirroredWorktree } from './visibility-types'

type Publications = AppState['agentSenderPublicationsByHost']

/** The frames' sender scopes folded in by revision; the same object when none is newer. */
export function receivedAgentSenderPublications(
  publications: Publications,
  host: string,
  snapshots: readonly RuntimeMobileSessionTabsResult[]
): Publications {
  let next = publications
  for (const snapshot of snapshots) {
    // A paired host's floating terminal is never mirrored here, as the tab apply skips it: its
    // senders open by asking that host, not through a pane this window lacks.
    const eligible = !host.startsWith('runtime:') || isHostMirroredWorktree(snapshot.worktree)
    const patch =
      eligible && snapshot.agentSenderAssociations
        ? agentSenderPublicationPatch(
            { agentSenderPublicationsByHost: next },
            host,
            snapshot.worktree,
            snapshot.agentSenderAssociations
          )
        : {}
    next = patch.agentSenderPublicationsByHost ?? next
  }
  return next
}

/** Sender data is ordered by its own revision, not by the tab frame carrying it: a frame the tab
 *  gates then drop (same version, unchanged census, a recovery that lost the race) may hold the
 *  only copy of a scope the stream won't send again. So it applies on receipt, once the caller
 *  has found the frame's connection and pairing current; a superseded runtime changes nothing. */
export function applyReceivedAgentSenderPublications(
  environmentId: string,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  runtimeId: string | undefined
): void {
  if (runtimeId && !isCurrentSessionTabsRuntimeFrame(environmentId, runtimeId)) {
    return
  }
  const current = useAppStore.getState().agentSenderPublicationsByHost
  const next = receivedAgentSenderPublications(current, `runtime:${environmentId}`, snapshots)
  if (next !== current) {
    useAppStore.setState({ agentSenderPublicationsByHost: next })
  }
}

/** A live stream frame's receipt, once its stream and runtime are current: its order, then its
 *  sender scopes. */
export function recordReceivedSessionTabsStreamFrame(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  runtimeId: string | undefined
): number {
  const frame = recordReceivedWebSessionTabsSnapshot(environmentId, snapshot, undefined, runtimeId)
  applyReceivedAgentSenderPublications(environmentId, [snapshot], runtimeId)
  return frame
}
