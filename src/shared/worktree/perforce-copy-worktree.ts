import type { Repo } from '../repository/repo-types'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR, splitWorktreeId } from './id'
import { normalizeRuntimePathForComparison } from '../file-access/cross-platform-path'
import { WORKTREE_ID_SEPARATOR } from '../terminal/pty/lifecycle/pty-session-id-format'

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

type CopyPathSplit = { name: string; source: string }

/** Each way to read `path` as `<root>.wt\<name>[\<inside>]`, one per `.wt` ancestor, outermost first. */
function copyPathSplits(path: string): CopyPathSplit[] {
  const trimmed = trimTrailingSeparators(path)
  return [...trimmed.matchAll(/[^\\/]\.wt([\\/])([A-Za-z0-9-]{1,24})(?=[\\/]|$)/gi)].map(
    (match) => {
      const sourceRoot = trimmed.slice(0, match.index + 1)
      const inside = trimmed.slice(match.index + match[0].length + 1)
      return { name: match[2], source: inside ? `${sourceRoot}${match[1]}${inside}` : sourceRoot }
    }
  )
}

/**
 * The copy name (`copy-1`) from a copy worktree path of folder project `projectPath`, or null when the
 * path is not a copy. Why the project: a `.wt` folder above the workspace would otherwise read as the copy.
 */
export function getPerforceCopyName(path: string, projectPath: string): string | null {
  const splits = copyPathSplits(path)
  const key = normalizeRuntimePathForComparison
  return (splits.find((split) => key(split.source) === key(projectPath)) ?? splits[0])?.name ?? null
}

/** The folders a copy worktree path may mirror (`D:\ws.wt\copy-1\Game` → `D:\ws\Game`), one per `.wt` ancestor. */
export function getPerforceCopySourcePaths(path: string): string[] {
  return copyPathSplits(path).map((split) => split.source)
}

// Why: deleting a copy also deletes its Perforce client, changelists and possibly shelves, so it goes
// through the Perforce copy confirmation, which shows exactly that, never a generic worktree delete.
export const PERFORCE_COPY_GENERIC_REMOVAL_MESSAGE =
  'This is a Perforce workspace copy. Delete it from the Orca sidebar (Delete Perforce copy), which shows what will be removed from this computer and from the Perforce server first.'
