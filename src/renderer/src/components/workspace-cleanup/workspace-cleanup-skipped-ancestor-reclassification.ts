import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type { WorkspaceCleanupFailure } from '@/store/slices/workspace-cleanup'
import {
  getSkippedAncestorMessage,
  type SkippedWorkspaceCleanupAncestor
} from './workspace-cleanup-ancestor-skips'

export type SkippedAncestorReclassification = {
  unblocked: WorkspaceCleanupCandidate[]
  updatedFailures: WorkspaceCleanupFailure[]
}

// Why: late child settlements must re-derive each skip from the current blocker
// set so provisional "still removing" rows harden or lift instead of going stale.
export function reclassifySkippedWorkspaceCleanupAncestors({
  skippedAncestors,
  findBlockingDescendants,
  provisionallyBlocked,
  failedCandidates,
  failures
}: {
  skippedAncestors: SkippedWorkspaceCleanupAncestor[]
  findBlockingDescendants: (
    candidate: WorkspaceCleanupCandidate
  ) => readonly WorkspaceCleanupCandidate[]
  provisionallyBlocked: Set<WorkspaceCleanupCandidate>
  failedCandidates: WorkspaceCleanupCandidate[]
  failures: WorkspaceCleanupFailure[]
}): SkippedAncestorReclassification {
  const unblocked: WorkspaceCleanupCandidate[] = []
  const updatedFailures: WorkspaceCleanupFailure[] = []
  let changed = true
  while (changed) {
    changed = false
    let index = 0
    while (index < skippedAncestors.length) {
      const entry = skippedAncestors[index]
      const blockers = findBlockingDescendants(entry.candidate)
      if (blockers.length === 0) {
        skippedAncestors.splice(index, 1)
        removeArrayEntry(failedCandidates, entry.candidate)
        removeArrayEntry(failures, entry.failure)
        provisionallyBlocked.delete(entry.candidate)
        unblocked.push(entry.candidate)
        changed = true
        continue
      }
      const provisional = blockers.every((blocker) => provisionallyBlocked.has(blocker))
      if (provisional !== entry.provisional) {
        entry.provisional = provisional
        entry.failure.message = getSkippedAncestorMessage(provisional)
        if (provisional) {
          provisionallyBlocked.add(entry.candidate)
        } else {
          provisionallyBlocked.delete(entry.candidate)
        }
        updatedFailures.push(entry.failure)
        changed = true
      }
      index += 1
    }
  }
  return { unblocked, updatedFailures }
}

function removeArrayEntry<T>(entries: T[], entry: T): void {
  const index = entries.indexOf(entry)
  if (index >= 0) {
    entries.splice(index, 1)
  }
}
