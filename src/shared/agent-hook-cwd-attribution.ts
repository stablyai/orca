import { existsSync, realpathSync } from 'node:fs'
import {
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  isWindowsAbsolutePathLike,
  resolveRuntimePath
} from './cross-platform-path'
import { splitWorktreeIdForFilesystem, WORKTREE_ID_SEPARATOR } from './worktree/id'

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

/** `resolved: null` means the path exists here but cannot be resolved (EPERM-style mounts,
 *  deleted mid-check) — with the alias question unanswerable on a local path, callers keep.
 *  Nonexistent paths keep their raw spelling so foreign-host paths keep the string verdict. */
function resolveLocalPath(path: string): { exists: boolean; resolved: string | null } {
  try {
    if (!existsSync(path)) {
      return { exists: false, resolved: path }
    }
    return { exists: true, resolved: realpathSync.native(path) }
  } catch {
    return { exists: true, resolved: null }
  }
}

const MACOS_DATA_VOLUME_PREFIX = '/System/Volumes/Data'

/** Firmlinks are not symlinks — realpath keeps /System/Volumes/Data/Users/… even though it
 *  names /Users/…. Folding the data-volume prefix runs only when the raw verdict already
 *  said drop, so it can only rescue rows. */
function foldMacOsDataVolumePrefix(path: string): string {
  return process.platform === 'darwin' && path.startsWith(`${MACOS_DATA_VOLUME_PREFIX}/`)
    ? path.slice(MACOS_DATA_VOLUME_PREFIX.length)
    : path
}

/**
 * `hookCwdContradictsWorktree`, re-judged on locally resolved paths before trusting a drop.
 *
 * Why: one directory can spell two fully disjoint strings — macOS /tmp is /private/tmp,
 * symlinked project roots, subst drives — and agents report physical getcwd while Orca
 * stores the path as picked, so a raw contradiction is only proof once symlink aliasing
 * is ruled out. Call this only where the current process runs on the host that owns both
 * paths (Orca's local HTTP ingest, the relay's own hook server).
 */
export function hookCwdContradictsWorktreeAfterLocalResolve(
  worktreeId: string | undefined,
  cwd: string | undefined
): boolean {
  if (!hookCwdContradictsWorktree(worktreeId, cwd)) {
    return false
  }
  const parsed = worktreeId ? splitWorktreeIdForFilesystem(worktreeId) : undefined
  if (!parsed || !cwd) {
    return true
  }
  const worktree = resolveLocalPath(parsed.worktreePath)
  const session = resolveLocalPath(cwd)
  if (worktree.resolved === null || session.resolved === null) {
    return false
  }
  // Why: exactly one side stat-able means the other side's recorded spelling cannot be
  // trusted on the host that owns it (renamed, deleted, or whitespace-mangled in transit) —
  // unclear keeps. Both-nonexistent still drops on the raw strings: that is the foreign-host
  // shape, where this process is not the judge of existence.
  if (worktree.exists !== session.exists) {
    return false
  }
  return hookCwdContradictsWorktree(
    `${parsed.repoId}${WORKTREE_ID_SEPARATOR}${foldMacOsDataVolumePrefix(worktree.resolved)}`,
    foldMacOsDataVolumePrefix(session.resolved)
  )
}
