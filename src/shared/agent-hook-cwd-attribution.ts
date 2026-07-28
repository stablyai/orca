import {
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  isWindowsAbsolutePathLike,
  resolveRuntimePath
} from './cross-platform-path'
import { splitWorktreeIdForFilesystem } from './worktree-id'

const UNC_NOTATION = /^(?:\/\/|\\\\)/

/**
 * True when the worktree a hook claims cannot own the session that sent it, judged
 * against the cwd that session reported in its own payload.
 *
 * Why: paneKey and worktreeId ride in PTY env, and env is inherited. A shared agent
 * daemon pre-warmed from one pane hands its Orca identity to every session it later
 * hosts, so a session in worktree A reports pane B and its status lands on the wrong
 * workspace card. Refuse only when both paths are absolute, written in the same
 * notation, and disjoint; anything unclear stays attributed, since dropping a real
 * status row is the worse failure.
 */
export function hookCwdContradictsWorktree(
  worktreeId: string | undefined,
  cwd: string | undefined
): boolean {
  const worktreePath = worktreeId
    ? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
    : undefined
  if (!worktreePath || !cwd) {
    return false
  }
  // Why: a relative path has no root, so containment either way is unknowable.
  if (!isRuntimePathAbsolute(worktreePath) || !isRuntimePathAbsolute(cwd)) {
    return false
  }
  // Why: UNC aliases another notation — \\wsl$\Ubuntu\mnt\c\x is C:\x, and \\server\share
  // is a mapped drive — so it can never disprove the other side.
  if (UNC_NOTATION.test(worktreePath) || UNC_NOTATION.test(cwd)) {
    return false
  }
  // Why: a WSL session reports /mnt/c/… for a C:\… worktree; mixed notations aren't comparable.
  // Together with the UNC bail this leaves the guard inert across WSL, since translating
  // either way needs the session's execution host, which the hook server doesn't know.
  if (isWindowsAbsolutePathLike(worktreePath) !== isWindowsAbsolutePathLike(cwd)) {
    return false
  }
  // Why: fold case even on POSIX, which normalizeRuntimePathForComparison deliberately
  // won't. Its callers pick candidates, so a missed match costs them nothing; here a
  // missed match drops a live status row, and macOS and Windows are case-insensitive.
  const workspace = resolveRuntimePath(worktreePath.toLowerCase(), '.')
  const session = resolveRuntimePath(cwd.toLowerCase(), '.')
  // Why: a session started in a subdirectory is normal, and so is a workspace nested
  // under the session root (folder workspaces); only fully disjoint paths are proof.
  return !isPathInsideOrEqual(workspace, session) && !isPathInsideOrEqual(session, workspace)
}
