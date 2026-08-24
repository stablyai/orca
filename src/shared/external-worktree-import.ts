import {
  isExplicitlyImportedExternalWorktreePath,
  mergeExternalWorktreeInboxPaths,
  removeExternalWorktreeInboxPath
} from './external-worktree-inbox'
import type { Repo } from './repo-types'
import type { DetectedWorktree } from './worktree/types'

export type ExternalWorktreeImportOutcome = 'imported' | 'already-imported' | 'always-visible'

export type ExternalWorktreeUnimportOutcome = 'unimported' | 'not-imported'

export type ExternalWorktreeImportDecision =
  | { outcome: 'imported'; importedExternalWorktreePaths: string[] }
  | { outcome: Exclude<ExternalWorktreeImportOutcome, 'imported'> }

export type ExternalWorktreeUnimportDecision =
  | { outcome: 'unimported'; importedExternalWorktreePaths: string[] }
  | { outcome: Exclude<ExternalWorktreeUnimportOutcome, 'unimported'> }

type ImportTargetRepo = Pick<Repo, 'importedExternalWorktreePaths'>

type ImportTargetWorktree = Pick<DetectedWorktree, 'path' | 'ownership' | 'selectedCheckout'>

/** Why: `shouldShowWorktree` returns true for the selected checkout and for
 *  Orca-created worktrees before it ever consults the import list, so storing
 *  their paths persists an entry that can never change what the sidebar shows
 *  — and later hands the visibility dialog a Hide action that does nothing. */
export function isVisibleWithoutExplicitImport(worktree: ImportTargetWorktree): boolean {
  return worktree.selectedCheckout || worktree.ownership === 'orca-managed'
}

export function decideExternalWorktreeImport(args: {
  repo: ImportTargetRepo
  worktree: ImportTargetWorktree
}): ExternalWorktreeImportDecision {
  if (isExplicitlyImportedExternalWorktreePath(args.worktree.path, args.repo)) {
    return { outcome: 'already-imported' }
  }
  if (isVisibleWithoutExplicitImport(args.worktree)) {
    return { outcome: 'always-visible' }
  }
  return {
    outcome: 'imported',
    importedExternalWorktreePaths: mergeExternalWorktreeInboxPaths(
      args.repo.importedExternalWorktreePaths,
      [args.worktree.path]
    )
  }
}

export function decideExternalWorktreeUnimport(args: {
  repo: ImportTargetRepo
  worktree: Pick<DetectedWorktree, 'path'>
}): ExternalWorktreeUnimportDecision {
  if (!isExplicitlyImportedExternalWorktreePath(args.worktree.path, args.repo)) {
    return { outcome: 'not-imported' }
  }
  return {
    outcome: 'unimported',
    importedExternalWorktreePaths: removeExternalWorktreeInboxPath(
      args.repo.importedExternalWorktreePaths,
      args.worktree.path
    )
  }
}
