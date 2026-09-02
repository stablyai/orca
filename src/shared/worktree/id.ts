import { normalizeRuntimePathForComparison } from '../cross-platform-path'
import { WORKTREE_ID_SEPARATOR } from '../pty-session-id-format'
import type { Repo } from '../repo-types'

export { WORKTREE_ID_SEPARATOR } from '../pty-session-id-format'

export type ParsedWorktreeId = {
  repoId: string
  worktreePath: string
}

export const FOLDER_WORKSPACE_INSTANCE_SEPARATOR = '::workspace:'
const FOLDER_WORKSPACE_INSTANCE_SUFFIX = new RegExp(
  `${FOLDER_WORKSPACE_INSTANCE_SEPARATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9a-f-]{36}$`
)

/**
 * Worktree id of the repo's own checkout. A bare repo id is never a valid worktree id —
 * runtimes reject it with `worktree_id_requires_full_path` (#16447).
 */
export function getRepoMainWorktreeId(repo: Pick<Repo, 'id' | 'path'>): string {
  return `${repo.id}${WORKTREE_ID_SEPARATOR}${repo.path}`
}

export function getRepoIdFromWorktreeId(worktreeId: string): string {
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  return separatorIdx === -1 ? worktreeId : worktreeId.slice(0, separatorIdx)
}

/**
 * Canonical comparison form of a worktree id: the repoId is compared EXACT and only the path folds,
 * through the same `normalizeRuntimePathForComparison` a `path:` selector has always applied and
 * byte-exact id matching denied the renderer (#16243). Null for a malformed id, so callers keep
 * exact matching for it. Comparison only — never persist or return this key.
 */
export function worktreeIdComparisonKey(worktreeId: string): string | null {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed || !parsed.repoId || !parsed.worktreePath) {
    return null
  }
  return `${parsed.repoId}${WORKTREE_ID_SEPARATOR}${normalizeRuntimePathForComparison(
    parsed.worktreePath
  )}`
}

/**
 * Why: workspace identity is per *workspace*, not per checkout dir. Folder projects back several
 * independent workspaces with one directory, separated only by the `::workspace:<uuid>` suffix that
 * filesystem callers must strip; stripping it here instead lets one session steal a sibling's PTYs.
 * Normalize only path spelling, so Windows/WSL/SSH ids still match themselves across hosts, and
 * fall back to exact equality for a malformed id.
 */
export function worktreeIdsEqual(left: string, right: string): boolean {
  const leftKey = worktreeIdComparisonKey(left)
  return leftKey === null ? left === right : leftKey === worktreeIdComparisonKey(right)
}

export function splitWorktreeId(worktreeId: string): ParsedWorktreeId | null {
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  if (separatorIdx === -1) {
    return null
  }
  return {
    repoId: worktreeId.slice(0, separatorIdx),
    worktreePath: worktreeId.slice(separatorIdx + WORKTREE_ID_SEPARATOR.length)
  }
}

export function splitWorktreeIdForFilesystem(worktreeId: string): ParsedWorktreeId | null {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed) {
    return null
  }
  return {
    repoId: parsed.repoId,
    // Why: folder projects can have multiple workspace sessions backed by the
    // same directory. Their IDs carry a UUID suffix, but filesystem callers
    // still need the real folder path as cwd/root.
    worktreePath: parsed.worktreePath.replace(FOLDER_WORKSPACE_INSTANCE_SUFFIX, '')
  }
}

export function getWorktreePathBasenameFromId(worktreeId: string): string | null {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const normalizedPath = parsed?.worktreePath.trim().replace(/[\\/]+$/g, '') ?? ''
  if (!normalizedPath) {
    return null
  }
  const basename = normalizedPath.split(/[\\/]/).findLast(Boolean)?.trim()
  return basename || null
}
