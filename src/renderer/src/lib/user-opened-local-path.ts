import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { isPathOutsideAllowedDirectoriesError } from '../../../shared/local-file-access'
import {
  isRemoteRuntimeFileOperation,
  statRuntimePath,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import { userNamedFileAccess } from './local-file-access'
import { isPathInsideWorktree } from './terminal-links'

export type UserOpenedPathStat = {
  isDirectory: boolean
  /** The path sits in the project but resolves outside it, e.g. through a symlink. */
  escapesWorktree: boolean
}

/**
 * Stats a path the user opened by a gesture. A local path inside the worktree is checked against
 * the project root first; if only the user-named check passes, the path leads out of the project,
 * and the caller must open it as an external file rather than a project one.
 */
export async function statUserOpenedPath(
  context: RuntimeFileOperationArgs,
  filePath: string
): Promise<UserOpenedPathStat> {
  // Why the floating workspace is skipped: its folder (~ by default) is not a project root.
  const insideLocalWorktree =
    context.worktreeId !== FLOATING_TERMINAL_WORKTREE_ID &&
    !context.connectionId &&
    !isRemoteRuntimeFileOperation(context, filePath) &&
    Boolean(context.worktreePath && isPathInsideWorktree(filePath, context.worktreePath))
  if (!insideLocalWorktree) {
    const stat = await statRuntimePath(context, filePath, userNamedFileAccess())
    return { isDirectory: stat.isDirectory, escapesWorktree: false }
  }
  try {
    const stat = await statRuntimePath(context, filePath)
    return { isDirectory: stat.isDirectory, escapesWorktree: false }
  } catch (containedError) {
    // Why only this refusal: a missing file or a dropped connection is not a link out of the project.
    if (!isPathOutsideAllowedDirectoriesError(containedError)) {
      throw containedError
    }
    let stat: Awaited<ReturnType<typeof statRuntimePath>>
    try {
      stat = await statRuntimePath(context, filePath, userNamedFileAccess())
    } catch {
      throw containedError
    }
    return { isDirectory: stat.isDirectory, escapesWorktree: true }
  }
}
