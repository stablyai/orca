import { isRuntimePathAbsolute } from '../../../../shared/cross-platform-path'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseVaultQuery } from './ai-vault-session-filters'

// Mirrors the operator arm of the panel tokenizer so the same spellings the
// client-side filter accepts are the ones stripped from the server text.
const QUERY_OPERATOR_PATTERN = /(?:repo|path):(?:"[^"]*"|'[^']*'|\S*)/gi

export type AiVaultSearchQuerySplit = {
  /** Free text sent to the index; operator terms removed. */
  text: string
  repoTerms: readonly string[]
  pathTerms: readonly string[]
}

export function splitAiVaultSearchQuery(query: string): AiVaultSearchQuerySplit {
  const parsed = parseVaultQuery(query)
  return {
    text: query.replaceAll(QUERY_OPERATOR_PATTERN, ' ').replace(/\s+/g, ' ').trim(),
    repoTerms: parsed.repoTerms,
    pathTerms: parsed.pathTerms
  }
}

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
