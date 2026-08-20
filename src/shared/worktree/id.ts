import { WORKTREE_ID_SEPARATOR } from '../pty-session-id-format'
import { normalizeRuntimePathForComparison } from '../cross-platform-path'

export { WORKTREE_ID_SEPARATOR } from '../pty-session-id-format'

export type ParsedWorktreeId = {
  repoId: string
  worktreePath: string
}

export const FOLDER_WORKSPACE_INSTANCE_SEPARATOR = '::workspace:'
const FOLDER_WORKSPACE_INSTANCE_SUFFIX = new RegExp(
  `${FOLDER_WORKSPACE_INSTANCE_SEPARATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9a-f-]{36}$`
)

export function getRepoIdFromWorktreeId(worktreeId: string): string {
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  return separatorIdx === -1 ? worktreeId : worktreeId.slice(0, separatorIdx)
}

/**
 * Canonical comparison form of a worktree id: one repo, one filesystem
 * location, one folder-workspace instance — regardless of separator or
 * drive-letter spelling.
 *
 * Why (#15598): git reports Windows paths with forward slashes while
 * app-written ids can carry backslashes, so the same checkout can sit in
 * `worktreeMeta` under two spellings. Exact-string set membership then
 * declares the other spelling "removed" on an authoritative scan, which purges
 * its terminals (force-kill) and lineage for a checkout that never went
 * anywhere. Comparison only — never persist or return this key.
 *
 * Returns null for malformed ids so callers can keep their exact-match
 * behavior for them.
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
