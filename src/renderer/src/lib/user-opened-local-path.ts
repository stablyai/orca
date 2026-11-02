import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { isPathOutsideAllowedDirectoriesError } from '../../../shared/local-file-access'
import { isRemoteRuntimeFileOperation } from '@/runtime/runtime-file-routing'
import { statRuntimePath } from '@/runtime/runtime-file-metadata-client'
import { readRuntimeDirectory } from '@/runtime/runtime-file-mutation-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { projectFolderLinkAccess, userNamedFileAccess } from './local-file-access'
import { isPathInsideWorktree } from '../../../shared/terminal-links'
import type { DirEntry } from '../../../shared/filesystem-entry-types'

export type UserOpenedPathStat = {
  isDirectory: boolean
  /** The path sits in the project but resolves outside it, e.g. through a symlink. */
  escapesWorktree: boolean
}

// Opening a path is a user act, so its stat may start a stopped WSL distro.
const USER_ACT = { wakeWslDistro: true }

function isInsideLocalWorktree(context: RuntimeFileOperationArgs, filePath: string): boolean {
  // Why the floating workspace is skipped: its folder (~ by default) is not a project root.
  return (
    context.worktreeId !== FLOATING_TERMINAL_WORKTREE_ID &&
    !context.connectionId &&
    !isRemoteRuntimeFileOperation(context, filePath) &&
    Boolean(context.worktreePath && isPathInsideWorktree(filePath, context.worktreePath))
  )
}

/** Stat user-opened local paths inside the project boundary first. If only user-named access succeeds, open externally: symlinks can lead outside despite lexical containment. */
export async function statUserOpenedPath(
  context: RuntimeFileOperationArgs,
  filePath: string
): Promise<UserOpenedPathStat> {
  if (!isInsideLocalWorktree(context, filePath)) {
    const stat = await statRuntimePath(context, filePath, userNamedFileAccess(), USER_ACT)
    return { isDirectory: stat.isDirectory, escapesWorktree: false }
  }
  try {
    const stat = await statRuntimePath(context, filePath, undefined, USER_ACT)
    return { isDirectory: stat.isDirectory, escapesWorktree: false }
  } catch (containedError) {
    // Why only this refusal: a missing file or a dropped connection is not a link out of the project.
    if (!isPathOutsideAllowedDirectoriesError(containedError)) {
      throw containedError
    }
    let stat: Awaited<ReturnType<typeof statRuntimePath>>
    try {
      stat = await statRuntimePath(context, filePath, userNamedFileAccess(), USER_ACT)
    } catch {
      throw containedError
    }
    return { isDirectory: stat.isDirectory, escapesWorktree: true }
  }
}

/** List a project folder contained first; with `followProjectFolderLink`, a refusal as outside retries as a project folder link. */
export async function readUserOpenedDirectory(
  context: RuntimeFileOperationArgs,
  dirPath: string,
  options: { followSymlinks?: boolean; wakeWslDistro?: boolean; followProjectFolderLink?: boolean }
): Promise<{ entries: DirEntry[]; escapesWorktree: boolean }> {
  const { followProjectFolderLink, ...readOptions } = options
  try {
    return {
      entries: await readRuntimeDirectory(context, dirPath, readOptions),
      escapesWorktree: false
    }
  } catch (containedError) {
    if (
      !followProjectFolderLink ||
      !isPathOutsideAllowedDirectoriesError(containedError) ||
      !isInsideLocalWorktree(context, dirPath)
    ) {
      throw containedError
    }
    try {
      const entries = await readRuntimeDirectory(context, dirPath, {
        ...readOptions,
        access: projectFolderLinkAccess()
      })
      return { entries, escapesWorktree: true }
    } catch (linkError) {
      // Why: a non-link refusal keeps its original error; a real link failure (EPERM, ENOENT) shows its own.
      throw isPathOutsideAllowedDirectoriesError(linkError) ? containedError : linkError
    }
  }
}
