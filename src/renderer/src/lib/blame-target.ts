import type { AppState } from '@/store/types'
import { getFolderWorkspaceCandidateRepos } from './folder-workspace-connection'
import { worktreePathFromState } from './worktree-path'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../shared/cross-platform-path'

export type BlameTargetPaths = {
  /** Repo root git runs in — a child repo for folder workspaces, not the workspace root. */
  rootPath: string
  /** Path relative to `rootPath`, which is what git blame is given. */
  relativePath: string
}

type BlameTargetState = Parameters<typeof getFolderWorkspaceCandidateRepos>[0] &
  Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>

/**
 * Resolve which repo should blame a file.
 *
 * Why: a folder workspace is not itself a repo — it can hold several, so the
 * workspace root plus the tab's workspace-relative path would ask the wrong
 * repo (or a non-repo) for authorship. Mirrors the longest-match rule that
 * per-file connection ownership already uses, so blame and its host agree.
 */
export function resolveBlameTarget(
  state: BlameTargetState,
  worktreeId: string | null | undefined,
  absoluteFilePath: string,
  workspaceRelativePath: string
): BlameTargetPaths | null {
  if (!worktreeId) {
    return null
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type !== 'folder') {
    const rootPath = worktreePathFromState(state, worktreeId)
    return rootPath ? { rootPath, relativePath: workspaceRelativePath } : null
  }
  const owningRepoPath = longestMatchingRepoPath(
    getFolderWorkspaceCandidateRepos(state, parsedWorkspaceKey.folderWorkspaceId).map(
      (repo) => repo.path
    ),
    absoluteFilePath
  )
  if (!owningRepoPath) {
    return null
  }
  const relativePath = relativePathInsideRoot(owningRepoPath, absoluteFilePath)
  return relativePath ? { rootPath: owningRepoPath, relativePath } : null
}

/** Deepest repo containing the file; null when two equally deep repos disagree. */
function longestMatchingRepoPath(repoPaths: string[], absoluteFilePath: string): string | null {
  // Why one pass with a pre-normalized candidate: this runs from a zustand
  // selector on every cursor move, and isPathInsideOrEqual would re-normalize
  // the file path once per repo — an ICU pass each time — while a sort would
  // allocate several arrays to learn a single maximum.
  const normalizedFilePath = normalizeRuntimePathForComparison(absoluteFilePath)
  let bestPath: string | null = null
  let bestLength = -1
  let tied = false
  for (const repoPath of repoPaths) {
    if (!createNormalizedPathInsideOrEqualMatcher(repoPath)(normalizedFilePath)) {
      continue
    }
    const length = normalizeRuntimePathForComparison(repoPath).length
    if (length > bestLength) {
      bestPath = repoPath
      bestLength = length
      tied = false
    } else if (length === bestLength) {
      tied = true
    }
  }
  return tied ? null : bestPath
}
