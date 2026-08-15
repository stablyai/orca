import type { Repo } from '../../../../../shared/repo-types'
import type { WorktreeVisibilityDefaults } from '../../../../../shared/global-settings-types'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../../shared/worktree/ownership'

export function getWorktreeVisibilityMenuLabel(
  repo: Repo,
  visibilityDefaults?: WorktreeVisibilityDefaults
): string {
  const visibility = effectiveExternalWorktreeVisibility(
    repo,
    isLegacyRepoForExternalWorktreeVisibility(repo),
    visibilityDefaults
  )
  return visibility === 'show' ? 'Hide non-Orca worktrees' : 'Show hidden worktrees'
}
