/**
 * What a committed WSL move's renderer stores ask of a key: does it name a moved local workspace,
 * and what are that workspace's id and paths on the host. Ids keep their repo; only a UNC path of
 * the moved distro changes, as the main-side rewrite (wsl-move-rewrite-scope.ts) maps it.
 */
import { parseWorkspaceKey } from '../workspace-scope'
import { wslUncPathToLinux } from '../wsl-paths'
import { getRepoIdFromWorktreeId, rewriteWorktreeIdPath } from '../worktree/id'
import type { WslMovePendingRendererRewrite } from './wsl-move-renderer-rewrite-types'

export type WslMoveRendererRewriteScope = {
  /** The host's form of a moved local worktree id or workspace key; null for anything else. */
  hostWorktreeId: (worktreeId: string) => string | null
  /** The host's path for a UNC path of the moved distro; null for anything else. */
  hostPath: (path: string) => string | null
  /** Whether a host path lies in one of the moved projects' directories. */
  inMovedRoot: (hostPath: string) => boolean
  /** The host's route, in the shape the renderer resolves for a runtime-owned worktree. */
  hostRoute: { executionHostId: `runtime:${string}`; runtimeEnvironmentId: string }
}

// `normalizeRuntimePathForComparison` folds both UNC spellings of a WSL path into this form.
const COMPARISON_FORM = /^\/\/wsl\/([^/]+)(\/[\s\S]*)?$/

export function wslMoveRendererRewriteScope(
  move: Pick<
    WslMovePendingRendererRewrite,
    | 'distro'
    | 'scopeRepoIds'
    | 'scopeFolderWorkspaceIds'
    | 'destinationHostId'
    | 'destinationEnvironmentId'
    | 'scopeRootPaths'
  >
): WslMoveRendererRewriteScope {
  const repoIds = new Set(move.scopeRepoIds)
  const folderIds = new Set(move.scopeFolderWorkspaceIds)
  const distro = move.distro.toLowerCase()
  const hostPath = (path: string): string | null => {
    const linux = wslUncPathToLinux(path, distro)
    if (linux !== null) {
      return linux
    }
    const folded = COMPARISON_FORM.exec(path)
    return folded && folded[1].toLowerCase() === distro ? (folded[2] ?? '/') : null
  }
  const hostWorktreeId = (worktreeId: string): string | null => {
    const key = parseWorkspaceKey(worktreeId)
    if (key?.type === 'folder') {
      return folderIds.has(key.folderWorkspaceId) ? worktreeId : null
    }
    if (key?.type === 'worktree') {
      const mapped = hostWorktreeId(key.worktreeId)
      return mapped === null ? null : `worktree:${mapped}`
    }
    // A folder workspace keeps its id; only its paths move.
    if (folderIds.has(worktreeId)) {
      return worktreeId
    }
    if (!repoIds.has(getRepoIdFromWorktreeId(worktreeId))) {
      return null
    }
    const mapped = rewriteWorktreeIdPath(worktreeId, (path) => hostPath(path) ?? path)
    return mapped === worktreeId ? null : mapped
  }
  return {
    hostWorktreeId,
    hostPath,
    inMovedRoot: (path) =>
      move.scopeRootPaths.some(
        (root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
      ),
    hostRoute: {
      executionHostId: move.destinationHostId,
      runtimeEnvironmentId: move.destinationEnvironmentId
    }
  }
}
