import type { Repo } from '../../../../../shared/repo-types'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../../shared/worktree/ownership'

export function getWorktreeVisibilityMenuLabel(repo: Repo): string {
  const visibility = effectiveExternalWorktreeVisibility(
    repo,
    isLegacyRepoForExternalWorktreeVisibility(repo)
  )
  return visibility === 'show' ? 'Hide non-Orca worktrees' : 'Show hidden worktrees'
}
