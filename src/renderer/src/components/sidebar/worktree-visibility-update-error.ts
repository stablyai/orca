import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../shared/repo-types'

export function worktreeVisibilityUpdateError(
  updateSucceeded: boolean,
  returnedPreferences: Repo['worktreeVisibilitySourcePreferences'],
  requestedPreferences: Repo['worktreeVisibilitySourcePreferences']
): string {
  if (updateSucceeded && returnedPreferences === undefined && requestedPreferences !== undefined) {
    return translate(
      'auto.components.sidebar.WorktreeVisibilityDialog.unsupportedHost',
      "This host doesn't support source-specific worktree visibility. Update Orca on the host to change this setting."
    )
  }
  return translate(
    'auto.components.sidebar.WorktreeVisibilityDialog.d40d436fc2',
    'Could not update worktree visibility. Try again.'
  )
}
