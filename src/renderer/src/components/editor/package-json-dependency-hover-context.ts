import type { AppState } from '@/store/types'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { getFolderWorkspaceCandidateRepos } from '@/lib/folder-workspace-connection'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type PackageJsonDependencyHoverContext = {
  worktreeRoot: string
  relativePath: string
  filePath: string
  worktreeId: string
  connectionId: string | null
  executionHostId: ExecutionHostId
  runtimeEnvironmentId?: string | null
  externalSshTargetId?: string
}

export type PackageJsonHoverStoreState = Pick<
  AppState,
  'openFiles' | 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'
>

/** Folder workspaces have no single `Worktree` row; fall back to the same
 * longest-path-wins candidate-repo match `getConnectionIdForFileFromState`
 * uses, so an ambiguous folder workspace fails closed here too. */
function findFolderWorkspaceRootPath(
  state: PackageJsonHoverStoreState,
  folderWorkspaceId: string,
  filePath: string
): string | undefined {
  const candidates = getFolderWorkspaceCandidateRepos(state, folderWorkspaceId)
    .filter((candidateRepo) => isPathInsideOrEqual(candidateRepo.path, filePath))
    .map((candidateRepo) => ({
      path: candidateRepo.path,
      normalizedPath: normalizeRuntimePathForComparison(candidateRepo.path)
    }))
    .sort((left, right) => right.normalizedPath.length - left.normalizedPath.length)
  const longestPathLength = candidates[0]?.normalizedPath.length
  if (!longestPathLength) {
    return undefined
  }
  const winners = new Set(
    candidates
      .filter((candidate) => candidate.normalizedPath.length === longestPathLength)
      .map((candidate) => candidate.path)
  )
  return winners.size === 1 ? [...winners][0] : undefined
}

function findWorktreeRootPath(
  state: PackageJsonHoverStoreState,
  worktreeId: string,
  filePath: string
): string | undefined {
  const owningWorktree = findWorktreeById(state.worktreesByRepo, worktreeId)
  if (owningWorktree) {
    return owningWorktree.path
  }
  const scope = parseWorkspaceKey(worktreeId)
  return scope?.type === 'folder'
    ? findFolderWorkspaceRootPath(state, scope.folderWorkspaceId, filePath)
    : undefined
}

/**
 * Resolves the worktree/host that owns a hovered `package.json` editor model.
 * Matches the open file by rebuilding its Monaco URI (never by parsing
 * `model.uri` back into a filesystem path, which breaks on Windows drive
 * letters — see useClosedEditorTabCleanup.ts). Any ambiguity along the way
 * (no matching open file, unresolved connection, unresolved worktree root or
 * execution host) fails closed: the caller shows no hover.
 */
export function resolvePackageJsonHoverContext(
  state: PackageJsonHoverStoreState,
  modelUri: string,
  toModelUriString: (filePath: string) => string
): PackageJsonDependencyHoverContext | undefined {
  const openFile = state.openFiles.find(
    (file) => file.mode === 'edit' && toModelUriString(file.filePath) === modelUri
  )
  if (!openFile) {
    return undefined
  }
  const connectionId = getConnectionIdForFileFromState(
    state,
    openFile.worktreeId,
    openFile.filePath
  )
  if (connectionId === undefined) {
    return undefined
  }
  const worktreeRoot = findWorktreeRootPath(state, openFile.worktreeId, openFile.filePath)
  if (!worktreeRoot) {
    return undefined
  }
  const executionHostId = getResolvedExecutionHostIdForWorktree(state, openFile.worktreeId)
  if (!executionHostId) {
    return undefined
  }
  return {
    worktreeRoot,
    relativePath: openFile.relativePath,
    filePath: openFile.filePath,
    worktreeId: openFile.worktreeId,
    connectionId,
    executionHostId,
    runtimeEnvironmentId: openFile.runtimeEnvironmentId,
    externalSshTargetId: openFile.externalSshTargetId
  }
}
