import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'

export function formatVanishedSelectionNotice(count: number): string {
  return count === 1
    ? translate(
        'components.workspace.cleanup.browse.selectionVanishedOne',
        '1 selected workspace no longer exists.'
      )
    : translate(
        'components.workspace.cleanup.browse.selectionVanished',
        '{{value0}} selected workspaces no longer exist.',
        { value0: count }
      )
}

/** Host-qualified identities, so a default selection cannot span two hosts' rows. */
export function getDefaultSelectedWorkspaceCleanupIdentities(
  candidates: readonly WorkspaceCleanupCandidate[],
  deletingIdentities: ReadonlySet<string> = new Set()
): Set<string> {
  return new Set(
    candidates
      .filter(
        (candidate) =>
          candidate.selectedByDefault &&
          !deletingIdentities.has(getWorkspaceCleanupCandidateIdentity(candidate))
      )
      .map((candidate) => getWorkspaceCleanupCandidateIdentity(candidate))
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
