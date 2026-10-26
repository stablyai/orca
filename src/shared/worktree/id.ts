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

/** Use the full repoId::path; runtimes reject bare repo IDs with worktree_id_requires_full_path (#16447). */
export function getRepoMainWorktreeId(repo: Pick<Repo, 'id' | 'path'>): string {
  return composeWorktreeId(repo.id, repo.path)
}

/** Worktree id for a checkout, spelled exactly as given: ids are never reassigned by a fold. */
export function composeWorktreeId(repoId: string, worktreePath: string): string {
  return `${repoId}${WORKTREE_ID_SEPARATOR}${worktreePath}`
}

export function getRepoIdFromWorktreeId(worktreeId: string): string {
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  return separatorIdx === -1 ? worktreeId : worktreeId.slice(0, separatorIdx)
}

/** Comparison only; never persist/return the key. Keep repo IDs exact, fold only path spelling as path: selectors do, and leave malformed IDs unchanged (#16243). */
export function worktreeIdentityKey(worktreeId: string): string {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed || !parsed.repoId || !parsed.worktreePath) {
    return worktreeId
  }
  return `${parsed.repoId}${WORKTREE_ID_SEPARATOR}${normalizeRuntimePathForComparison(
    parsed.worktreePath
  )}`
}

/** Preserve folder-workspace instance suffixes: several sessions share one directory and must not steal sibling PTYs. Normalize path spelling only. */
export function worktreeIdsEqual(left: string, right: string): boolean {
  return worktreeIdentityKey(left) === worktreeIdentityKey(right)
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
    // Filesystem callers need the folder path without its workspace-session UUID suffix.
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
