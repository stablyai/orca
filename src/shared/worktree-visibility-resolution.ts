import { isExplicitlyImportedExternalWorktreePath } from './external-worktree-inbox'
import {
  effectiveAgentWorktreeVisibility,
  effectiveExternalWorktreeVisibility
} from './external-worktree-visibility'
import {
  effectiveWorktreeSourceVisibility,
  type WorktreeVisibilitySourceMatcher
} from './worktree/visibility-sources'
import type { GlobalSettings } from './global-settings-types'
import type { Repo } from './repo-types'
import type { Worktree, WorktreeOwnership } from './worktree/types'

export function shouldShowWorktree(args: {
  worktree: Pick<Worktree, 'path'>
  ownership: WorktreeOwnership
  repo: Repo
  isLegacyRepoForVisibility: boolean
  isSelectedCheckout: boolean
  visibilityDefaults?: GlobalSettings['worktreeVisibilityDefaults']
  importedExternalWorktreePaths?: readonly string[] | undefined
  visibilitySource?: ReturnType<WorktreeVisibilitySourceMatcher>
}): boolean {
  if (args.isSelectedCheckout || args.ownership === 'orca-managed') {
    return true
  }
  if (
    isExplicitlyImportedExternalWorktreePath(args.worktree.path, {
      importedExternalWorktreePaths: args.importedExternalWorktreePaths
    })
  ) {
    return true
  }
  if (args.visibilitySource) {
    return (
      effectiveWorktreeSourceVisibility(
        args.repo,
        args.visibilitySource,
        args.visibilityDefaults
      ) === 'show'
    )
  }
  if (args.ownership === 'agent-scratch') {
    return effectiveAgentWorktreeVisibility(args.repo) === 'show'
  }
  if (args.ownership === 'unknown-legacy' && args.isLegacyRepoForVisibility) {
    return true
  }
  return (
    effectiveExternalWorktreeVisibility(
      args.repo,
      args.isLegacyRepoForVisibility,
      args.visibilityDefaults
    ) === 'show'
  )
}
