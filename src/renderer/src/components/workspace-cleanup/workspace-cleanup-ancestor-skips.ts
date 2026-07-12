import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { WorkspaceCleanupFailure } from '@/store/slices/workspace-cleanup'
import { translate } from '@/i18n/i18n'

// Why: an ancestor skip is provisional while every blocking descendant is still
// removing; it hardens or lifts once the blockers settle authoritatively.
export type SkippedWorkspaceCleanupAncestor = {
  candidate: WorkspaceCleanupCandidate
  failure: WorkspaceCleanupFailure
  provisional: boolean
}

export function getSkippedAncestorMessage(provisional: boolean): string {
  return provisional
    ? translate(
        'auto.components.workspace.cleanup.backgroundRemoval.skippedPendingAncestor',
        'Skipped because a nested workspace has not finished removing.'
      )
    : translate(
        'auto.components.workspace.cleanup.backgroundRemoval.skippedAncestor',
        'Skipped because a nested workspace could not be removed.'
      )
}

export function isStrictWorkspaceCleanupDescendant(
  parent: WorkspaceCleanupCandidate,
  child: WorkspaceCleanupCandidate
): boolean {
  return (
    parent.connectionId === child.connectionId &&
    isStrictWorkspaceCleanupDescendantPath(parent.path, child.path)
  )
}

function isStrictWorkspaceCleanupDescendantPath(parentPath: string, childPath: string): boolean {
  return (
    normalizeRuntimePathForComparison(parentPath) !==
      normalizeRuntimePathForComparison(childPath) && isPathInsideOrEqual(parentPath, childPath)
  )
}
