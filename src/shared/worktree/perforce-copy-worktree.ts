import type { Repo } from '../repo-types'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR, splitWorktreeId, WORKTREE_ID_SEPARATOR } from './id'

// A Perforce workspace copy lives in its own folder, `<workspace>.wt\<name>` beside the source, and is
// listed as a worktree of the source's folder project with a git-style `${repoId}::${path}` id.
const COPY_PATH_SEGMENT = /[\\/][^\\/]+\.wt[\\/][A-Za-z0-9-]{1,24}(?:[\\/]|$)/i

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

export function isPerforceCopyPath(path: string): boolean {
  return COPY_PATH_SEGMENT.test(trimTrailingSeparators(path))
}

/** True when `worktreeId` names a Perforce copy of folder project `repo` (not the folder itself). */
export function isPerforceCopyWorktreeIdForRepo(
  repo: Pick<Repo, 'id' | 'path'>,
  worktreeId: string
): boolean {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed || parsed.repoId !== repo.id) {
    return false
  }
  const path = parsed.worktreePath
  if (path.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)) {
    return false
  }
  if (
    trimTrailingSeparators(path).toLowerCase() === trimTrailingSeparators(repo.path).toLowerCase()
  ) {
    return false
  }
  return isPerforceCopyPath(path)
}

export function getPerforceCopyWorktreeId(
  repo: Pick<Repo, 'id'>,
  copyWorktreePath: string
): string {
  return `${repo.id}${WORKTREE_ID_SEPARATOR}${copyWorktreePath}`
}

/** The copy name (`copy-1`) from a copy worktree path, or null when the path is not a copy. */
export function getPerforceCopyName(path: string): string | null {
  const match = /[\\/][^\\/]+\.wt[\\/]([A-Za-z0-9-]{1,24})(?:[\\/]|$)/i.exec(
    trimTrailingSeparators(path)
  )
  return match?.[1] ?? null
}

// Why: deleting a copy also deletes its Perforce client, changelists and possibly shelves, so it goes
// through the Perforce copy confirmation, which shows exactly that, never a generic worktree delete.
export const PERFORCE_COPY_GENERIC_REMOVAL_MESSAGE =
  'This is a Perforce workspace copy. Delete it from the Orca sidebar (Delete Perforce copy), which shows what will be removed from this computer and from the Perforce server first.'
