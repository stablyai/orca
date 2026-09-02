import { isRuntimePathAbsolute } from '../../../../shared/cross-platform-path'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AiVaultSearchQuerySplit } from '../../../../shared/ai-vault-search-query-operators'

// Re-exported so the panel keeps splitting and resolving through one import.
export {
  splitAiVaultSearchQuery,
  type AiVaultSearchQuerySplit
} from '../../../../shared/ai-vault-search-query-operators'

/**
 * Operator terms narrowed to absolute paths the panel already knows about, so
 * the index can pre-filter by cwd. A term that matches nothing is left to the
 * client-side filter rather than silently emptying the result.
 */
export function resolveAiVaultSearchScopePaths(
  split: Pick<AiVaultSearchQuerySplit, 'repoTerms' | 'pathTerms'>,
  context: {
    worktrees: readonly Pick<Worktree, 'path' | 'repoId'>[]
    repos: readonly Pick<Repo, 'id' | 'displayName' | 'path'>[]
  }
): string[] {
  const paths = new Set<string>()
  for (const term of split.repoTerms) {
    for (const repo of context.repos) {
      if (!repo.displayName.toLowerCase().includes(term)) {
        continue
      }
      addSearchScopePath(paths, repo.path)
      for (const worktree of context.worktrees) {
        if (worktree.repoId === repo.id) {
          addSearchScopePath(paths, worktree.path)
        }
      }
    }
  }
  for (const term of split.pathTerms) {
    if (isRuntimePathAbsolute(term)) {
      addSearchScopePath(paths, term)
      continue
    }
    for (const worktree of context.worktrees) {
      if (worktree.path.toLowerCase().includes(term)) {
        addSearchScopePath(paths, worktree.path)
      }
    }
  }
  return [...paths]
}

function addSearchScopePath(paths: Set<string>, pathValue: string): void {
  const trimmed = pathValue.trim()
  if (trimmed && isRuntimePathAbsolute(trimmed)) {
    paths.add(trimmed)
  }
}
