import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'

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

export function getDefaultSelectedWorkspaceCleanupIds(
  candidates: readonly WorkspaceCleanupCandidate[],
  deletingWorktreeIds: ReadonlySet<string> = new Set()
): Set<string> {
  return new Set(
    candidates
      .filter(
        (candidate) => candidate.selectedByDefault && !deletingWorktreeIds.has(candidate.worktreeId)
      )
      .map((candidate) => candidate.worktreeId)
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
