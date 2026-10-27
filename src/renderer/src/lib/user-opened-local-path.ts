import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { isPathOutsideAllowedDirectoriesError } from '../../../shared/local-file-access'
import { isRemoteRuntimeFileOperation } from '@/runtime/runtime-file-routing'
import { statRuntimePath } from '@/runtime/runtime-file-metadata-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { userNamedFileAccess } from './local-file-access'
import { isPathInsideWorktree } from './terminal-links'

export type UserOpenedPathStat = {
  isDirectory: boolean
  /** The path sits in the project but resolves outside it, e.g. through a symlink. */
  escapesWorktree: boolean
}

// Opening a path is a user act, so its stat may start a stopped WSL distro.
const USER_ACT = { wakeWslDistro: true }

/** Stat user-opened local paths inside the project boundary first. If only user-named access succeeds, open externally: symlinks can lead outside despite lexical containment. */
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
