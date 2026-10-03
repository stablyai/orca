import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  latestReceivedSessionTabsInventoryFrameByEnvironment,
  latestReceivedSessionTabsSnapshotByWorktree,
  latestSessionTabsSnapshotByWorktree,
  lastHostTerminalTabCountByWorktree,
  sessionTabsEnvironmentsByWorktree,
  sessionTabsPublicationEpochHistoryByWorktree,
  sessionTabsRemovalWatermarkByWorktree,
  setBoundedSessionTabsReceipt,
  trackedSessionTabsWorktreeIdsByEnvironment,
  nextReceivedSessionTabsFrame,
  type SnapshotFreshness,
  type SessionTabsListAllResult,
  type TrackedWebSessionTabsWorktree
} from './state'
import {
  acceptSessionTabsRuntimeId,
  isCurrentSessionTabsRuntimeId,
  isRetiredSessionTabsPublicationEpoch,
  isRetiredSessionTabsRuntimeId,
  noteSessionTabsPublicationEpoch,
  recordReceivedWebSessionTabsEnvironmentFrame
} from './publisher-identity-fences'
import { hostSnapshotAffirmsWorktreeContents } from '../host-session-snapshot-authority'
import { scheduleWebRetiredEpochRepair } from './retired-epoch-repair'

export function isSessionTabsListAllResult(value: unknown): value is SessionTabsListAllResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as { snapshots?: unknown }).snapshots)
  )
}

export function sessionTabsFreshnessKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}:${worktreeId}`
}

export function advancesSessionTabsFreshness(
  snapshot: RuntimeMobileSessionTabsResult,
  baseline: SnapshotFreshness
): boolean {
  return (
    snapshot.publicationEpoch !== baseline.publicationEpoch ||
    snapshot.snapshotVersion > baseline.snapshotVersion
  )
}

export function getTrackedWebSessionTabsWorktrees(
  environmentId: string
): TrackedWebSessionTabsWorktree[] {
  return [...(trackedSessionTabsWorktreeIdsByEnvironment.get(environmentId) ?? [])].flatMap(
    (worktree) => {
      const key = sessionTabsFreshnessKey(environmentId, worktree)
      const freshness = latestSessionTabsSnapshotByWorktree.get(key)
      return freshness
        ? [
            {
              worktree,
              freshness
            }
          ]
        : []
    }
  )
}

export function trackWebSessionTabsWorktree(environmentId: string, worktreeId: string): void {
  const worktrees = trackedSessionTabsWorktreeIdsByEnvironment.get(environmentId) ?? new Set()
  worktrees.add(worktreeId)
  trackedSessionTabsWorktreeIdsByEnvironment.set(environmentId, worktrees)
}

export function untrackWebSessionTabsWorktree(environmentId: string, worktreeId: string): void {
  const worktrees = trackedSessionTabsWorktreeIdsByEnvironment.get(environmentId)
  if (!worktrees) {
    return
  }
  worktrees.delete(worktreeId)
  if (worktrees.size === 0) {
    trackedSessionTabsWorktreeIdsByEnvironment.delete(environmentId)
  }
}

export type WebSessionTabsReceiptOptions = {
  /**
   * Marks this receipt as an authoritative `session.tabs.list` / inventory answer, which may revive
   * a retired publication epoch. Subscription frames must omit this — only a census we just asked
   * for can settle a returning publisher.
   */
  authoritative?: boolean
}

export function recordReceivedWebSessionTabsSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number | undefined = undefined,
  runtimeId?: string,
  source: 'stream' | 'bootstrap' = 'stream',
  options: WebSessionTabsReceiptOptions = {}
): number {
  const frame = receivedFrame ?? nextReceivedSessionTabsFrame()
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const current = latestReceivedSessionTabsSnapshotByWorktree.get(key)
  // A bootstrap listAll reserves its frame before the request starts. If a
  // stream frame for this worktree arrived meanwhile, the late list is stale
  // evidence and must not advance epoch history.
  if (source === 'bootstrap' && current && frame < current.receivedFrame) {
    return frame
  }
  if (runtimeId && !acceptSessionTabsRuntimeId(environmentId, runtimeId, frame)) {
    return frame
  }
  recordReceivedWebSessionTabsEnvironmentFrame(environmentId, frame)
  const publicationEpoch = snapshot.publicationEpoch
  const isRetraction = 'removed' in snapshot && snapshot.removed === true
  const history = sessionTabsPublicationEpochHistoryByWorktree.get(key)
  // Retirement is a property of the lineage, not of the exact string: matching exactly here let a
  // `:headless-merge:` rebuild of a retired generation be noted as current, which then retired the
  // live one and locked it out of its own worktree.
  //
  // Why not just drop: an epoch is retired whenever another publisher takes over the worktree, but
  // a live publisher can return after a temporary headless epoch. Only an authoritative census can
  // settle that; subscription frames stay fenced and schedule repair instead.
  if (isRetiredSessionTabsPublicationEpoch(key, publicationEpoch)) {
    if (!options.authoritative) {
      scheduleWebRetiredEpochRepair(environmentId, snapshot.worktree, publicationEpoch)
      return frame
    }
    // Authoritative census: admit into the receipt ledger below, but do not mutate `retired`
    // here. Revival belongs on the accepted decide path after ordering gates pass.
  }
  // Neither a retraction nor a "nothing published yet" placeholder takes over publishing this
  // worktree, so neither may be noted as current: doing so retires the generation that is still
  // live and fences its next frame out of its own worktree.
  // Skip noting while the epoch is still retired — fence mutations wait for decide acceptance.
  if (
    !isRetraction &&
    hostSnapshotAffirmsWorktreeContents(snapshot) &&
    (!history || history.current !== publicationEpoch) &&
    !isRetiredSessionTabsPublicationEpoch(key, publicationEpoch)
  ) {
    noteSessionTabsPublicationEpoch(key, publicationEpoch)
  }
  // Stream delivery order is the freshest evidence even when a host's version
  // counter briefly moves backwards (for example across a visibility resume).
  // Bootstrap listAll responses retain version/epoch ordering so a late
  // response cannot replace a stream frame received after the request began.
  if (
    source === 'stream' ||
    !current ||
    current.publicationEpoch !== publicationEpoch ||
    snapshot.snapshotVersion > current.snapshotVersion ||
    (snapshot.snapshotVersion === current.snapshotVersion && current.receivedFrame <= frame)
  ) {
    setBoundedSessionTabsReceipt(
      latestReceivedSessionTabsSnapshotByWorktree,
      key,
      {
        receivedFrame: frame,
        publicationEpoch,
        snapshotVersion: snapshot.snapshotVersion,
        ...(runtimeId ? { runtimeId } : {})
      },
      (entry) => entry.receivedFrame
    )
    if (isRetraction) {
      recordReceivedWebSessionTabsRemoval(environmentId, snapshot.worktree, frame, publicationEpoch)
    }
  }
  return frame
}

export function recordReceivedWebSessionTabsInventory(environmentId: string): number {
  const receivedFrame = nextReceivedSessionTabsFrame()
  recordReceivedWebSessionTabsEnvironmentFrame(environmentId, receivedFrame)
  latestReceivedSessionTabsInventoryFrameByEnvironment.set(environmentId, receivedFrame)
  return receivedFrame
}

export function recordReceivedWebSessionTabsRemoval(
  environmentId: string,
  worktreeId: string,
  receivedFrame: number,
  publicationEpoch: string
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const latest = latestReceivedSessionTabsSnapshotByWorktree.get(key)
  // A retraction is this worktree's newest evidence, not an absence of it. The ledger slot lets the
  // live publisher's next frame outrank the pre-close one on version; the watermark is what the
  // slot cannot be, because a later frame overwrites the slot and the boundary has to outlive it.
  if (!latest || latest.receivedFrame <= receivedFrame) {
    setBoundedSessionTabsReceipt(
      latestReceivedSessionTabsSnapshotByWorktree,
      key,
      { receivedFrame, publicationEpoch, snapshotVersion: 0 },
      (entry) => entry.receivedFrame
    )
  }
  const watermark = sessionTabsRemovalWatermarkByWorktree.get(key) ?? 0
  if (receivedFrame > watermark) {
    sessionTabsRemovalWatermarkByWorktree.set(key, receivedFrame)
  }
}

/** True for a frame whose place in receipt order was fixed before this worktree was last retracted. */
export function precedesWebSessionTabsRemoval(key: string, receivedFrame: number): boolean {
  return receivedFrame < (sessionTabsRemovalWatermarkByWorktree.get(key) ?? 0)
}

export function shouldApplyRecoveredWebSessionTabsSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number,
  runtimeId?: string,
  options: WebSessionTabsReceiptOptions = {}
): boolean {
  if (
    runtimeId &&
    (isRetiredSessionTabsRuntimeId(environmentId, runtimeId) ||
      !isCurrentSessionTabsRuntimeId(environmentId, runtimeId))
  ) {
    return false
  }
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  if (isRetiredSessionTabsPublicationEpoch(key, snapshot.publicationEpoch)) {
    if (!options.authoritative) {
      scheduleWebRetiredEpochRepair(environmentId, snapshot.worktree, snapshot.publicationEpoch)
      return false
    }
    // Authoritative: leave `retired` alone until decide accepts after the ordering gates below.
  }
  if (precedesWebSessionTabsRemoval(key, receivedFrame)) {
    return false
  }

  const latest = latestReceivedSessionTabsSnapshotByWorktree.get(key)
  if (!latest || latest.receivedFrame === receivedFrame) {
    return latest !== undefined
  }
  if (latest.publicationEpoch !== snapshot.publicationEpoch) {
    return receivedFrame > latest.receivedFrame
  }
  return snapshot.snapshotVersion >= latest.snapshotVersion
}

export function recordAcceptedWebSessionTabsEnvironment(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  const environments = new Set(sessionTabsEnvironmentsByWorktree.get(snapshot.worktree) ?? [])
  if (snapshot.tabs.length > 0) {
    environments.add(environmentId)
  } else {
    environments.delete(environmentId)
  }
  if (environments.size > 0) {
    sessionTabsEnvironmentsByWorktree.set(snapshot.worktree, environments)
  } else {
    sessionTabsEnvironmentsByWorktree.delete(snapshot.worktree)
  }
}

export function removeWebSessionTabsEnvironment(environmentId: string, worktreeId: string): void {
  const environments = new Set(sessionTabsEnvironmentsByWorktree.get(worktreeId) ?? [])
  environments.delete(environmentId)
  if (environments.size > 0) {
    sessionTabsEnvironmentsByWorktree.set(worktreeId, environments)
  } else {
    sessionTabsEnvironmentsByWorktree.delete(worktreeId)
  }
}

export function rememberHostTerminalTabCount(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const terminalCount = snapshot.tabs.filter((tab) => tab.type === 'terminal').length
  lastHostTerminalTabCountByWorktree.set(key, terminalCount)
}
