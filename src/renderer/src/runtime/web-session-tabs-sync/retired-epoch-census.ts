import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { getRuntimeEnvironmentRevision } from '../runtime-environment-revision'
import {
  admitRetiredValueUnderAuthority,
  isRetiredSessionTabsPublicationEpoch,
  sameSessionTabsPublicationLineage
} from './publisher-identity-fences'
import { createSessionTabsAuthorityRepairLane } from './session-tabs-authority-repair'
import {
  latestReceivedSessionTabsSnapshotByWorktree,
  nextReceivedSessionTabsFrame,
  sessionTabsPublicationEpochHistoryByWorktree
} from './state'
import { isSessionTabsListAllResult, sessionTabsFreshnessKey } from './tracking'

// Why no generation fence here: each census re-checks its own subscription before applying.
const pairedRepairLane = createSessionTabsAuthorityRepairLane({
  logLabel: 'web-session-tabs-sync',
  isStillRetired: isRetiredSessionTabsPublicationEpoch
})

// Why: a drop from a resumed subscription coalesces into a timer an older one scheduled.
const latestArgsByKey = new Map<string, RetiredEpochCensusArgs>()

export type RetiredEpochCensusArgs = {
  environmentId: string
  expectedEnvironmentPairingRevision?: number
  isCurrent: () => boolean
  /** Applies the census's snapshot for the dropped worktree through the normal stream path. */
  applySnapshot: (
    snapshot: RuntimeMobileSessionTabsResult,
    response: RuntimeRpcResponse<unknown>
  ) => void
}

/**
 * A paired host mints short-lived `headless:` epochs for one worktree between renderer frames, so a
 * live renderer publisher returning after one looks retired. Ask the host which epoch is current.
 */
export function scheduleRetiredEpochCensus(
  args: RetiredEpochCensusArgs,
  worktreeId: string,
  publicationEpoch: string
): void {
  const key = sessionTabsFreshnessKey(args.environmentId, worktreeId)
  latestArgsByKey.set(key, args)
  pairedRepairLane.schedule(key, publicationEpoch, () =>
    runCensus(latestArgsByKey.get(key) ?? args, key, worktreeId)
  )
}

async function runCensus(
  args: RetiredEpochCensusArgs,
  key: string,
  worktreeId: string
): Promise<void> {
  if (!args.isCurrent()) {
    return
  }
  const requestFrame = nextReceivedSessionTabsFrame()
  const response = await window.api.runtimeEnvironments.call({
    selector: args.environmentId,
    method: 'session.tabs.listAll',
    params: {},
    timeoutMs: 15_000,
    expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
  })
  if (
    !args.isCurrent() ||
    getRuntimeEnvironmentRevision(args.environmentId) !== args.expectedEnvironmentPairingRevision ||
    !response.ok ||
    !isSessionTabsListAllResult(response.result) ||
    // Why: an older host's unlabeled census may be partial, so it cannot revive anything.
    response.result.authoritative !== true ||
    // Why: a stream frame received after the request began is fresher; it re-schedules if dropped.
    (latestReceivedSessionTabsSnapshotByWorktree.get(key)?.receivedFrame ?? 0) > requestFrame
  ) {
    return
  }
  const snapshot = response.result.snapshots.find((candidate) => candidate.worktree === worktreeId)
  if (!snapshot) {
    return
  }
  admitRetiredValueUnderAuthority(
    sessionTabsPublicationEpochHistoryByWorktree.get(key),
    snapshot.publicationEpoch,
    true,
    sameSessionTabsPublicationLineage
  )
  args.applySnapshot(snapshot, response)
}

export function forgetRetiredEpochCensuses(isGone: (key: string) => boolean): void {
  pairedRepairLane.forget(isGone)
  for (const key of latestArgsByKey.keys()) {
    if (isGone(key)) {
      latestArgsByKey.delete(key)
    }
  }
}

export function resetRetiredEpochCensusesForTests(): void {
  pairedRepairLane.resetForTests()
  latestArgsByKey.clear()
}
