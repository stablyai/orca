import { translate } from '@/i18n/i18n'
import {
  canQueueWorkspaceCleanupCandidate,
  type WorkspaceCleanupCandidate
} from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'

export function formatVanishedSelectionNotice(count: number): string {
  return translate(
    'components.workspace.cleanup.browse.selectionVanishedCount',
    '{{count}} selected workspaces no longer exist.',
    { count, defaultValue_one: '{{count}} selected workspace no longer exists.' }
  )
}

export function formatWithheldSelectionNotice(count: number): string {
  return translate(
    'components.workspace.cleanup.browse.selectionWithheldCount',
    '{{count}} selected workspaces are hidden by the current filters and were deselected.',
    {
      count,
      defaultValue_one:
        '{{count}} selected workspace is hidden by the current filters and was deselected.'
    }
  )
}

export function toggleSetMember(current: Set<string>, value: string): Set<string> {
  const next = new Set(current)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
}

/** Ticked rows delete can queue and that are not already being deleted, from live row data. */
export function getSelectedDeletableCandidates(
  rows: readonly { identity: string; candidate: WorkspaceCleanupCandidate }[],
  selectedIds: ReadonlySet<string>,
  deletingIdentities: ReadonlySet<string>
): WorkspaceCleanupCandidate[] {
  const byIdentity = new Map(rows.map((row) => [row.identity, row.candidate]))
  return [...selectedIds]
    .map((identity) => byIdentity.get(identity))
    .filter(
      (candidate): candidate is WorkspaceCleanupCandidate =>
        candidate != null &&
        canQueueWorkspaceCleanupCandidate(candidate) &&
        !deletingIdentities.has(getWorkspaceCleanupCandidateIdentity(candidate))
    )
}

/** Re-resolves candidates against the live rows so stale snapshots never reach a delete. */
export function getLiveDeletableCandidates(
  rows: readonly { identity: string; candidate: WorkspaceCleanupCandidate }[],
  candidates: readonly WorkspaceCleanupCandidate[],
  deletingIdentities: ReadonlySet<string>
): WorkspaceCleanupCandidate[] {
  const selectedIds = new Set(candidates.map(getWorkspaceCleanupCandidateIdentity))
  return getSelectedDeletableCandidates(rows, selectedIds, deletingIdentities)
}
