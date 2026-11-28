import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  latestReceivedSessionTabsSnapshotByWorktree,
  latestSessionTabsSnapshotByWorktree,
  lastHostTerminalTabCountByWorktree,
  sessionTabsEnvironmentsByWorktree,
  trackedSessionTabsWorktreeIdsByEnvironment,
  sessionTabsFreshnessKey,
  type SnapshotFreshness,
  type SessionTabsListAllResult,
  type TrackedWebSessionTabsWorktree
} from '../state'
import {
  acceptSessionTabsRuntimeId,
  isCurrentSessionTabsRuntimeFrame,
  isRetiredSessionTabsPublicationEpoch
} from './publisher-identity-fences'
import { hostSnapshotAffirmsWorktreeContents } from '../../../../../shared/remote-runtime/session-graph/host-session-snapshot-authority'
import { precedesWebSessionTabsRemoval } from './session-tabs-receipts'

export {
  precedesWebSessionTabsRemoval,
  recordReceivedWebSessionTabsInventory,
  recordReceivedWebSessionTabsRemoval,
  recordReceivedWebSessionTabsSnapshot,
  recordReceivedWebSessionTabsSnapshots,
  recordWebSessionTabsReplyForChatReadMarks
} from './session-tabs-receipts'

export function isSessionTabsListAllResult(value: unknown): value is SessionTabsListAllResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as { snapshots?: unknown }).snapshots)
  )
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

export function shouldApplyRecoveredWebSessionTabsSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number,
  runtimeId?: string
): boolean {
  return (
    isCurrentSessionTabsRuntimeFrame(environmentId, runtimeId) &&
    canApplyWebSessionTabsWorktreeFrame(environmentId, snapshot, receivedFrame, 'recovery')
  )
}

/** Admit the verified replacement runtime before its feed arrives, without advancing the worktree cursor. */
export function admitWebSessionTabsChatRead(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number,
  runtimeId: string | undefined,
  verifiedRuntimeId: string | undefined
): boolean {
  return (
    canApplyWebSessionTabsWorktreeFrame(environmentId, snapshot, receivedFrame, 'read') &&
    (isCurrentSessionTabsRuntimeFrame(environmentId, runtimeId) ||
      (runtimeId !== undefined &&
        runtimeId === verifiedRuntimeId &&
        acceptSessionTabsRuntimeId(environmentId, runtimeId, receivedFrame)))
  )
}

function canApplyWebSessionTabsWorktreeFrame(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number,
  source: 'recovery' | 'read'
): boolean {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  if (isRetiredSessionTabsPublicationEpoch(key, snapshot.publicationEpoch)) {
    return false
  }
  if (precedesWebSessionTabsRemoval(key, receivedFrame)) {
    return false
  }

  const latest = latestReceivedSessionTabsSnapshotByWorktree.get(key)
  if (!latest) {
    return source === 'read'
  }
  if (latest.receivedFrame === receivedFrame) {
    return true
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
  if (!hostSnapshotAffirmsWorktreeContents(snapshot)) {
    // Why: "ask me later" is not a count of zero; a restarting host may be about to republish.
    lastHostTerminalTabCountByWorktree.delete(key)
    return
  }
  const terminalCount = snapshot.tabs.filter((tab) => tab.type === 'terminal').length
  lastHostTerminalTabCountByWorktree.set(key, terminalCount)
}
